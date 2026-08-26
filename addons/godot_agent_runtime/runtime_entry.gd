# SPDX-License-Identifier: MIT

extends SceneTree

const PROTOCOL_VERSION := "0.4.0"
const MAX_MESSAGE_BYTES := 1024 * 1024


class PeerState:
	extends RefCounted
	var stream: StreamPeerTCP
	var buffer := PackedByteArray()
	var handled := false


class RuntimeBridge:
	extends Node

	var _server: TCPServer
	var _peers: Array[PeerState] = []
	var _port := 0
	var _token := ""
	var _run_id := ""
	var _exclusive_operation_active := false


	func _ready() -> void:
		process_mode = Node.PROCESS_MODE_ALWAYS
		_port = int(OS.get_environment("GODOT_AGENT_RUNTIME_PORT"))
		_token = OS.get_environment("GODOT_AGENT_RUNTIME_TOKEN")
		_run_id = OS.get_environment("GODOT_AGENT_RUNTIME_RUN_ID")
		if _port < 1 or _port > 65535 or _token.is_empty() or _run_id.is_empty():
			push_error("GODOT_AGENT_RUNTIME_BRIDGE_CONFIG_INVALID")
			get_tree().quit(78)
			return
		_server = TCPServer.new()
		var error := _server.listen(_port, "127.0.0.1")
		if error != OK:
			push_error("GODOT_AGENT_RUNTIME_BRIDGE_LISTEN_FAILED:%d" % error)
			get_tree().quit(69)
			return
		print("GODOT_AGENT_RUNTIME_BRIDGE_READY:%s:%d" % [_run_id, _port])


	func _process(_delta: float) -> void:
		if _server == null or not _server.is_listening():
			return
		while _server.is_connection_available():
			var stream := _server.take_connection()
			if stream == null:
				break
			stream.set_no_delay(true)
			var peer := PeerState.new()
			peer.stream = stream
			_peers.append(peer)

		var index := _peers.size() - 1
		while index >= 0:
			var peer := _peers[index]
			_poll_peer(peer)
			if peer.stream == null or peer.stream.get_status() != StreamPeerTCP.STATUS_CONNECTED:
				_peers.remove_at(index)
			index -= 1


	func _poll_peer(peer: PeerState) -> void:
		peer.stream.poll()
		if peer.stream.get_status() != StreamPeerTCP.STATUS_CONNECTED or peer.handled:
			return
		var available := peer.stream.get_available_bytes()
		if available > 0:
			var received := peer.stream.get_partial_data(available)
			if received[0] == OK:
				peer.buffer.append_array(received[1])
		if peer.buffer.size() > MAX_MESSAGE_BYTES:
			_send_error(peer, "RUNTIME_REQUEST_TOO_LARGE", "Request exceeded 1 MiB.", "")
			return
		var newline := peer.buffer.find(10)
		if newline < 0:
			return
		peer.handled = true
		var line := peer.buffer.slice(0, newline).get_string_from_utf8()
		_handle_request(peer, line)


	func _handle_request(peer: PeerState, line: String) -> void:
		var parsed = JSON.parse_string(line)
		if typeof(parsed) != TYPE_DICTIONARY:
			_send_error(peer, "RUNTIME_REQUEST_INVALID", "Request must be a JSON object.", "")
			return
		var request: Dictionary = parsed
		var request_id := str(request.get("id", ""))
		if request_id.is_empty():
			_send_error(peer, "RUNTIME_REQUEST_INVALID", "Request id is required.", "")
			return
		if not _constant_time_equal(str(request.get("token", "")), _token):
			_send_error(peer, "RUNTIME_UNAUTHORIZED", "Invalid or missing runtime token.", request_id)
			return
		var command := str(request.get("command", ""))
		var params = request.get("params", {})
		if typeof(params) != TYPE_DICTIONARY:
			_send_error(peer, "RUNTIME_REQUEST_INVALID", "params must be an object.", request_id)
			return
		var request_timeout_ms := clampi(int(request.get("timeoutMs", 5000)), 100, 32000)
		var deadline_ms := Time.get_ticks_msec() + request_timeout_ms
		var result: Dictionary = await _dispatch(command, params, peer, deadline_ms)
		if result.has("_error"):
			var failure: Dictionary = result["_error"]
			_send_error(peer, str(failure.code), str(failure.message), request_id, failure.get("details", {}))
			return
		_send(peer, {"id": request_id, "ok": true, "result": result})


	func _dispatch(command: String, params: Dictionary, peer: PeerState, deadline_ms: int) -> Dictionary:
		match command:
			"hello":
				return {
					"protocolVersion": PROTOCOL_VERSION,
					"engineVersion": Engine.get_version_info().get("string", "unknown"),
					"scene": get_tree().current_scene.scene_file_path if get_tree().current_scene != null else null,
					"capabilities": ["screenshot", "screenshot_receipt", "ui", "scene_tree", "node", "observe", "simulate", "spatial_3d", "input", "input_sequence", "assert", "wait", "control"],
				}
			"screenshot":
				return await _capture_screenshot(params)
			"ui_find":
				return _find_ui(params)
			"scene_tree":
				return _scene_tree(params)
			"node_get":
				return _node_get(params)
			"observe":
				return _observe_nodes(params)
			"simulate":
				if not await _acquire_exclusive_operation(peer, deadline_ms):
					return _request_cancelled()
				var simulation_result := await _simulate_physics(params, peer, deadline_ms)
				_release_exclusive_operation()
				return simulation_result
			"project_3d":
				return _project_3d(params)
			"raycast_3d":
				return _raycast_3d(params)
			"input":
				if not await _acquire_exclusive_operation(peer, deadline_ms):
					return _request_cancelled()
				var input_result := await _inject_input(params, peer, deadline_ms)
				_release_exclusive_operation()
				return input_result
			"input_sequence":
				if not await _acquire_exclusive_operation(peer, deadline_ms):
					return _request_cancelled()
				var sequence_result := await _inject_input_sequence(params, peer, deadline_ms)
				_release_exclusive_operation()
				return sequence_result
			"assert":
				return _assert_state(params)
			"wait":
				return await _wait_for_state(params)
			"control":
				if not await _acquire_exclusive_operation(peer, deadline_ms):
					return _request_cancelled()
				var control_result := await _control_runtime(params, peer, deadline_ms)
				_release_exclusive_operation()
				return control_result
			_:
				return _failure("RUNTIME_COMMAND_UNKNOWN", "Unknown runtime command: %s" % command)


	func _runtime_scene_identity() -> Dictionary:
		var scene := get_tree().current_scene
		if scene == null:
			return {"instanceId": 0, "scenePath": null}
		return {
			"instanceId": scene.get_instance_id(),
			"scenePath": scene.scene_file_path if not scene.scene_file_path.is_empty() else null,
		}


	func _capture_screenshot(params: Dictionary) -> Dictionary:
		var before := _runtime_scene_identity()
		if params.has("expectedScenePath"):
			var expected_scene_path := str(params.get("expectedScenePath", ""))
			if before.scenePath != expected_scene_path:
				return _failure("EVIDENCE_SCENE_MISMATCH", "The live runtime scene does not match expectedScenePath.", {
					"expectedScenePath": expected_scene_path,
					"actualScenePath": before.scenePath,
				})
		await get_tree().process_frame
		var test_switch_scene_path := OS.get_environment("GODOT_AGENT_RUNTIME_TEST_SCREENSHOT_SWITCH_SCENE_PATH")
		if not test_switch_scene_path.is_empty():
			var switch_error := get_tree().change_scene_to_file(test_switch_scene_path)
			if switch_error != OK:
				return _failure("RUNTIME_SCREENSHOT_TEST_SCENE_SWITCH_FAILED", "Could not switch the screenshot race fixture scene.", {"error": switch_error})
			await get_tree().process_frame
			await get_tree().process_frame
		RenderingServer.force_draw(false, 0.0)
		var image := get_viewport().get_texture().get_image()
		if image == null or image.is_empty():
			return _failure("RUNTIME_SCREENSHOT_EMPTY", "The root viewport did not produce an image.")
		var directory := ProjectSettings.globalize_path(
			"res://.godot/agent-runtime/evidence/%s" % _run_id
		)
		var mkdir_error := DirAccess.make_dir_recursive_absolute(directory)
		if mkdir_error != OK:
			return _failure("RUNTIME_SCREENSHOT_DIRECTORY_FAILED", "Could not create evidence directory.", {"error": mkdir_error})
		var filename := "screenshot-%d.png" % Time.get_ticks_msec()
		var path := directory.path_join(filename)
		var save_error := image.save_png(path)
		if save_error != OK:
			return _failure("RUNTIME_SCREENSHOT_SAVE_FAILED", "Could not save the screenshot.", {"error": save_error})
		var after := _runtime_scene_identity()
		if before.instanceId != after.instanceId or before.scenePath != after.scenePath:
			var cleanup_error := DirAccess.remove_absolute(path)
			return _failure("EVIDENCE_SCENE_CHANGED_DURING_CAPTURE", "The live runtime scene changed while the screenshot was being captured.", {
				"beforeScenePath": before.scenePath,
				"afterScenePath": after.scenePath,
				"path": path.replace("\\", "/"),
				"cleanupError": cleanup_error,
			})
		return {
			"path": path.replace("\\", "/"),
			"width": image.get_width(),
			"height": image.get_height(),
			"scenePath": after.scenePath,
			"capturedAt": Time.get_datetime_string_from_system(true, false) + "Z",
		}


	func _find_ui(params: Dictionary) -> Dictionary:
		var selector = params.get("selector", {})
		if typeof(selector) != TYPE_DICTIONARY:
			return _failure("RUNTIME_SELECTOR_INVALID", "selector must be an object.")
		var limit := clampi(int(params.get("limit", 100)), 1, 500)
		var elements: Array[Dictionary] = []
		var budget: Array[int] = [10000]
		var total := _collect_controls(get_tree().root, selector, limit, elements, budget)
		return {
			"count": total,
			"truncated": total > elements.size() or budget[0] <= 0,
			"elements": elements,
		}


	func _scene_tree(params: Dictionary) -> Dictionary:
		var max_depth := int(params.get("maxDepth", 16))
		var max_nodes := int(params.get("maxNodes", 2000))
		if max_depth < 0 or max_depth > 64:
			return _failure("RUNTIME_TREE_DEPTH_INVALID", "maxDepth must be between 0 and 64.", {"maxDepth": max_depth})
		if max_nodes < 1 or max_nodes > 5000:
			return _failure("RUNTIME_TREE_LIMIT_INVALID", "maxNodes must be between 1 and 5000.", {"maxNodes": max_nodes})
		var root := get_tree().current_scene
		var budget: Array[int] = [max_nodes]
		var truncated: Array[bool] = [false]
		return {
			"root": _describe_tree(root, 0, max_depth, budget, truncated) if root != null else null,
			"truncated": truncated[0],
		}


	func _describe_tree(node: Node, depth: int, max_depth: int, budget: Array[int], truncated: Array[bool]) -> Dictionary:
		budget[0] -= 1
		var children: Array[Dictionary] = []
		if depth < max_depth:
			for child in node.get_children():
				if budget[0] <= 0:
					truncated[0] = true
					break
				children.append(_describe_tree(child, depth + 1, max_depth, budget, truncated))
		elif node.get_child_count() > 0:
			truncated[0] = true
		return {
			"path": str(node.get_path()),
			"name": str(node.name),
			"type": node.get_class(),
			"scenePath": node.scene_file_path if not node.scene_file_path.is_empty() else null,
			"children": children,
		}


	func _node_get(params: Dictionary) -> Dictionary:
		var path := str(params.get("nodePath", ""))
		var node := _node_at_path(path)
		if node == null:
			return _failure("RUNTIME_NODE_NOT_FOUND", "Node was not found in the running scene.", {"nodePath": path})
		var requested = params.get("properties", [])
		if typeof(requested) != TYPE_ARRAY or requested.size() > 100:
			return _failure("RUNTIME_PROPERTIES_INVALID", "properties must be an array with at most 100 names.")
		var properties := {}
		for property_value in requested:
			var property := str(property_value)
			if not _has_property(node, property):
				return _failure("RUNTIME_PROPERTY_NOT_FOUND", "Node property does not exist.", {"nodePath": path, "property": property})
			properties[property] = _serialize(node.get(property))
		return {
			"node": {
				"path": str(node.get_path()),
				"name": str(node.name),
				"type": node.get_class(),
				"parentPath": str(node.get_parent().get_path()) if node.get_parent() != null else null,
				"scenePath": node.scene_file_path if not node.scene_file_path.is_empty() else null,
				"properties": properties,
			},
		}


	func _observe_nodes(params: Dictionary) -> Dictionary:
		var raw_paths = params.get("nodePaths", [])
		if typeof(raw_paths) != TYPE_ARRAY or raw_paths.is_empty() or raw_paths.size() > 32:
			return _failure("RUNTIME_OBSERVE_PATHS_INVALID", "nodePaths must contain between 1 and 32 node paths.")
		var extra_properties = params.get("properties", [])
		if typeof(extra_properties) != TYPE_ARRAY or extra_properties.size() > 32:
			return _failure("RUNTIME_OBSERVE_PROPERTIES_INVALID", "properties must be an array with at most 32 names.")
		var nodes: Array[Dictionary] = []
		for path_value in raw_paths:
			var path := str(path_value)
			var node := _node_at_path(path)
			if node == null:
				return _failure("RUNTIME_NODE_NOT_FOUND", "Node was not found in the running scene.", {"nodePath": path})
			var described := _describe_observation(node, extra_properties)
			if described.has("_error"):
				return described
			nodes.append(described)
		return {"count": nodes.size(), "nodes": nodes}


	func _describe_observation(node: Node, extra_properties: Array) -> Dictionary:
		var state := {}
		var common_properties := [
			"position", "global_position", "rotation", "rotation_degrees", "scale",
			"velocity", "linear_velocity", "angular_velocity", "visible",
			"animation", "frame", "playing", "current_animation", "current_animation_position",
		]
		for property in common_properties:
			if _has_property(node, property):
				state[property] = _serialize(node.get(property))
		for property_value in extra_properties:
			var property := str(property_value)
			if property.begins_with("meta:"):
				var meta_name := property.trim_prefix("meta:")
				if not node.has_meta(meta_name):
					return _failure("RUNTIME_PROPERTY_NOT_FOUND", "Node metadata does not exist.", {"nodePath": str(node.get_path()), "property": property})
				state[property] = _serialize(node.get_meta(meta_name))
			elif not _has_property(node, property):
				return _failure("RUNTIME_PROPERTY_NOT_FOUND", "Node property does not exist.", {"nodePath": str(node.get_path()), "property": property})
			else:
				state[property] = _serialize(node.get(property))
		if node is CharacterBody2D:
			var body_2d := node as CharacterBody2D
			state["is_on_floor"] = body_2d.is_on_floor()
			state["is_on_wall"] = body_2d.is_on_wall()
			state["is_on_ceiling"] = body_2d.is_on_ceiling()
		elif node is CharacterBody3D:
			var body_3d := node as CharacterBody3D
			state["is_on_floor"] = body_3d.is_on_floor()
			state["is_on_wall"] = body_3d.is_on_wall()
			state["is_on_ceiling"] = body_3d.is_on_ceiling()
		var groups: Array[String] = []
		for group_value in node.get_groups():
			var group := str(group_value)
			if not group.begins_with("_") and groups.size() < 100:
				groups.append(group)
		var metadata := {}
		var meta_names: Array = node.get_meta_list()
		for index in range(mini(meta_names.size(), 32)):
			var meta_name := str(meta_names[index])
			metadata[meta_name] = _serialize(node.get_meta(meta_names[index]))
		return {
			"path": str(node.get_path()),
			"name": str(node.name),
			"type": node.get_class(),
			"scenePath": node.scene_file_path if not node.scene_file_path.is_empty() else null,
			"groups": groups,
			"metadata": metadata,
			"state": state,
		}


	func _simulate_physics(params: Dictionary, peer: PeerState, deadline_ms: int) -> Dictionary:
		var node_path := str(params.get("nodePath", ""))
		var source_node := _node_at_path(node_path)
		var source_scene := get_tree().current_scene
		if source_node == null or source_scene == null or not (source_node == source_scene or source_scene.is_ancestor_of(source_node)):
			return _failure("RUNTIME_SIMULATION_NODE_NOT_FOUND", "Simulation node must belong to the current scene.", {"nodePath": node_path})
		var pending_nodes: Array[Node] = [source_scene]
		var scene_node_count := 0
		while not pending_nodes.is_empty():
			var counted_node: Node = pending_nodes.pop_back()
			scene_node_count += 1
			if scene_node_count > 5000:
				return _failure("RUNTIME_SIMULATION_SCENE_TOO_LARGE", "Isolated simulation is limited to scenes with at most 5000 nodes.", {"nodeCount": scene_node_count})
			for counted_child in counted_node.get_children():
				pending_nodes.append(counted_child)
		var frames := int(params.get("frames", 1))
		if frames < 1 or frames > 120:
			return _failure("RUNTIME_SIMULATION_FRAMES_INVALID", "frames must be between 1 and 120.", {"frames": frames})
		var raw_properties = params.get("properties", ["position", "global_position", "velocity"])
		if typeof(raw_properties) != TYPE_ARRAY or raw_properties.is_empty() or raw_properties.size() > 32:
			return _failure("RUNTIME_SIMULATION_PROPERTIES_INVALID", "properties must contain between 1 and 32 names.")
		for property_value in raw_properties:
			var property := str(property_value)
			if property.begins_with("meta:"):
				if not source_node.has_meta(property.trim_prefix("meta:")):
					return _failure("RUNTIME_PROPERTY_NOT_FOUND", "Node metadata does not exist.", {"nodePath": node_path, "property": property})
			elif not _has_property(source_node, property) and not _is_character_body_state(source_node, property):
				return _failure("RUNTIME_PROPERTY_NOT_FOUND", "Node property does not exist.", {"nodePath": node_path, "property": property})
		var action := str(params.get("action", ""))
		if not action.is_empty() and not InputMap.has_action(action):
			return _failure("RUNTIME_INPUT_ACTION_UNKNOWN", "InputMap action does not exist.", {"action": action})

		var relative_path := source_scene.get_path_to(source_node)
		var sandbox := SubViewport.new()
		sandbox.name = "GodotAgentSimulation"
		sandbox.own_world_3d = true
		sandbox.process_mode = Node.PROCESS_MODE_ALWAYS
		var clone := source_scene.duplicate()
		if clone == null:
			sandbox.free()
			return _failure("RUNTIME_SIMULATION_DUPLICATE_FAILED", "Godot could not duplicate the current scene for isolated simulation.")
		clone.name = source_scene.name
		clone.process_mode = Node.PROCESS_MODE_ALWAYS
		sandbox.add_child(clone)
		get_tree().root.add_child(sandbox)
		var simulated_node := clone if relative_path == NodePath(".") else clone.get_node_or_null(relative_path)
		if simulated_node == null:
			sandbox.queue_free()
			return _failure("RUNTIME_SIMULATION_NODE_NOT_FOUND", "The duplicated scene did not contain the requested node.", {"nodePath": node_path})
		if not _request_is_active(peer, deadline_ms):
			sandbox.queue_free()
			return _request_cancelled()

		var tree := get_tree()
		var was_paused := tree.paused
		var live_process_modes := _disable_scene_processing(source_scene)
		var live_physics_spaces := _suspend_live_physics(source_scene)
		# The sandbox needs global physics ticks. The live scene is isolated by disabled
		# process modes and inactive physics spaces instead of pausing SceneTree physics.
		tree.paused = false
		var before_physics_frames := Engine.get_physics_frames()
		var samples: Array[Dictionary] = [{"frame": 0, "properties": _sample_properties(simulated_node, raw_properties)}]
		var action_was_pressed := false
		var action_previous_strength := 0.0
		if not action.is_empty():
			action_previous_strength = Input.get_action_raw_strength(action)
			# Raw strength preserves simulated actions below the InputMap deadzone too.
			action_was_pressed = Input.is_action_pressed(action) or action_previous_strength > 0.0
			Input.action_press(action, clampf(float(params.get("strength", 1.0)), 0.0, 1.0))
		for frame in range(1, frames + 1):
			await tree.physics_frame
			if not _request_is_active(peer, deadline_ms):
				_restore_simulation_state(tree, was_paused, live_process_modes, live_physics_spaces, action, action_was_pressed, action_previous_strength)
				sandbox.queue_free()
				return _request_cancelled({"frame": frame})
			if not is_instance_valid(simulated_node):
				_restore_simulation_state(tree, was_paused, live_process_modes, live_physics_spaces, action, action_was_pressed, action_previous_strength)
				sandbox.queue_free()
				return _failure("RUNTIME_SIMULATION_NODE_FREED", "The simulated node was freed before sampling completed.", {"frame": frame})
			samples.append({"frame": frame, "properties": _sample_properties(simulated_node, raw_properties)})
		var advanced := Engine.get_physics_frames() - before_physics_frames
		_restore_simulation_state(tree, was_paused, live_process_modes, live_physics_spaces, action, action_was_pressed, action_previous_strength)
		var restored := tree.paused == was_paused
		sandbox.queue_free()
		return {
			"nodePath": node_path,
			"isolated": true,
			"framesRequested": frames,
			"physicsFramesAdvanced": advanced,
			"pausedRestored": restored,
			"action": action if not action.is_empty() else null,
			"samples": samples,
		}


	func _sample_properties(node: Node, properties: Array) -> Dictionary:
		var sampled := {}
		for property_value in properties:
			var property := str(property_value)
			if property.begins_with("meta:"):
				sampled[property] = _serialize(node.get_meta(property.trim_prefix("meta:"), null))
			elif _is_character_body_state(node, property):
				sampled[property] = _character_body_state(node, property)
			else:
				sampled[property] = _serialize(node.get(property))
		return sampled


	func _is_character_body_state(node: Node, property: String) -> bool:
		return (node is CharacterBody2D or node is CharacterBody3D) and property in ["is_on_floor", "is_on_wall", "is_on_ceiling"]


	func _character_body_state(node: Node, property: String) -> bool:
		if node is CharacterBody2D:
			var body_2d := node as CharacterBody2D
			if property == "is_on_floor": return body_2d.is_on_floor()
			if property == "is_on_wall": return body_2d.is_on_wall()
			return body_2d.is_on_ceiling()
		var body_3d := node as CharacterBody3D
		if property == "is_on_floor": return body_3d.is_on_floor()
		if property == "is_on_wall": return body_3d.is_on_wall()
		return body_3d.is_on_ceiling()


	func _disable_scene_processing(scene: Node) -> Array[Dictionary]:
		var states: Array[Dictionary] = []
		var pending: Array[Node] = [scene]
		while not pending.is_empty():
			var node: Node = pending.pop_back()
			states.append({"node": node, "processMode": node.process_mode})
			node.process_mode = Node.PROCESS_MODE_DISABLED
			for child in node.get_children():
				pending.append(child)
		return states


	func _restore_scene_processing(states: Array[Dictionary]) -> void:
		for state in states:
			var node: Node = state.node
			if is_instance_valid(node):
				node.process_mode = int(state.processMode)


	func _suspend_live_physics(scene: Node) -> Array[Dictionary]:
		var viewports: Array[Viewport] = [scene.get_viewport()]
		var pending: Array[Node] = [scene]
		while not pending.is_empty():
			var node: Node = pending.pop_back()
			if node is Viewport and node != viewports[0]:
				viewports.append(node as Viewport)
			for child in node.get_children():
				pending.append(child)

		var states: Array[Dictionary] = []
		for viewport in viewports:
			var world_2d := viewport.find_world_2d()
			if world_2d != null:
				_suspend_physics_space(states, world_2d.space, 2)
			var world_3d := viewport.find_world_3d()
			if world_3d != null:
				_suspend_physics_space(states, world_3d.space, 3)
		return states


	func _suspend_physics_space(states: Array[Dictionary], space: RID, dimension: int) -> void:
		if not space.is_valid():
			return
		for state in states:
			if int(state.dimension) == dimension and state.space == space:
				return
		var active := PhysicsServer2D.space_is_active(space) if dimension == 2 else PhysicsServer3D.space_is_active(space)
		states.append({"space": space, "dimension": dimension, "active": active})
		if dimension == 2:
			PhysicsServer2D.space_set_active(space, false)
		else:
			PhysicsServer3D.space_set_active(space, false)


	func _restore_live_physics(states: Array[Dictionary]) -> void:
		for state in states:
			var space: RID = state.space
			if not space.is_valid():
				continue
			if int(state.dimension) == 2:
				PhysicsServer2D.space_set_active(space, bool(state.active))
			else:
				PhysicsServer3D.space_set_active(space, bool(state.active))


	func _restore_simulation_state(tree: SceneTree, was_paused: bool, process_modes: Array[Dictionary], physics_spaces: Array[Dictionary], action: String, action_was_pressed: bool, action_previous_strength: float) -> void:
		if not action.is_empty():
			if action_was_pressed:
				Input.action_press(action, action_previous_strength)
			else:
				Input.action_release(action)
		tree.paused = was_paused
		_restore_live_physics(physics_spaces)
		_restore_scene_processing(process_modes)


	func _project_3d(params: Dictionary) -> Dictionary:
		var camera_result := _resolve_camera_3d(params)
		if camera_result.has("_error"):
			return camera_result
		var camera: Camera3D = camera_result.camera
		var node_path := str(params.get("nodePath", ""))
		var world_position := Vector3.ZERO
		if not node_path.is_empty():
			var node := _node_at_path(node_path)
			if not node is Node3D:
				return _failure("RUNTIME_3D_NODE_INVALID", "nodePath must resolve to a Node3D.", {"nodePath": node_path})
			world_position = (node as Node3D).global_position
		else:
			var decoded := _decode_vector3(params.get("worldPosition", null))
			if decoded.has("_error"):
				return decoded
			world_position = decoded.value
		var viewport_size := camera.get_viewport().get_visible_rect().size
		if viewport_size.x <= 0 or viewport_size.y <= 0:
			return _failure("RUNTIME_3D_VIEWPORT_EMPTY", "The active camera viewport has no visible area.")
		var screen_position := camera.unproject_position(world_position)
		var behind := camera.is_position_behind(world_position)
		var local_position := camera.to_local(world_position)
		return {
			"cameraPath": str(camera.get_path()),
			"nodePath": node_path if not node_path.is_empty() else null,
			"worldPosition": _serialize(world_position),
			"screenPosition": _serialize(screen_position),
			"viewport": {"width": int(viewport_size.x), "height": int(viewport_size.y)},
			"behind": behind,
			"onScreen": not behind and screen_position.x >= 0.0 and screen_position.y >= 0.0 and screen_position.x < viewport_size.x and screen_position.y < viewport_size.y,
			"depth": -local_position.z,
			"distance": camera.global_position.distance_to(world_position),
		}


	func _raycast_3d(params: Dictionary) -> Dictionary:
		var camera_result := _resolve_camera_3d(params)
		if camera_result.has("_error"):
			return camera_result
		var camera: Camera3D = camera_result.camera
		var screen_value = params.get("screenPosition", null)
		if typeof(screen_value) != TYPE_DICTIONARY or screen_value.size() != 2 or not screen_value.has("x") or not screen_value.has("y"):
			return _failure("RUNTIME_3D_SCREEN_POSITION_INVALID", "screenPosition must contain numeric x and y values.")
		for coordinate in ["x", "y"]:
			var coordinate_type := typeof(screen_value[coordinate])
			if coordinate_type != TYPE_INT and coordinate_type != TYPE_FLOAT:
				return _failure("RUNTIME_3D_SCREEN_POSITION_INVALID", "screenPosition values must be numbers.", {"coordinate": coordinate})
		var screen_position := Vector2(float(screen_value.x), float(screen_value.y))
		if not is_finite(screen_position.x) or not is_finite(screen_position.y):
			return _failure("RUNTIME_3D_SCREEN_POSITION_INVALID", "screenPosition values must be finite numbers.")
		var max_distance := float(params.get("maxDistance", 1000.0))
		if not is_finite(max_distance) or max_distance <= 0.0 or max_distance > 100000.0:
			return _failure("RUNTIME_3D_RAY_DISTANCE_INVALID", "maxDistance must be greater than 0 and at most 100000.", {"maxDistance": max_distance})
		var collision_mask := int(params.get("collisionMask", 4294967295))
		if collision_mask < 0:
			return _failure("RUNTIME_3D_COLLISION_MASK_INVALID", "collisionMask must be non-negative.", {"collisionMask": collision_mask})
		var ray_origin := camera.project_ray_origin(screen_position)
		var ray_direction := camera.project_ray_normal(screen_position).normalized()
		var query := PhysicsRayQueryParameters3D.create(ray_origin, ray_origin + ray_direction * max_distance, collision_mask)
		query.collide_with_bodies = bool(params.get("collideWithBodies", true))
		query.collide_with_areas = bool(params.get("collideWithAreas", false))
		var hit := camera.get_world_3d().direct_space_state.intersect_ray(query)
		var collider_data = null
		if not hit.is_empty():
			var collider = hit.get("collider")
			collider_data = {
				"path": str(collider.get_path()) if collider is Node else null,
				"type": collider.get_class() if collider is Object else "unknown",
			}
		return {
			"cameraPath": str(camera.get_path()),
			"screenPosition": _serialize(screen_position),
			"rayOrigin": _serialize(ray_origin),
			"rayDirection": _serialize(ray_direction),
			"maxDistance": max_distance,
			"collisionMask": collision_mask,
			"hit": not hit.is_empty(),
			"collider": collider_data,
			"position": _serialize(hit.position) if not hit.is_empty() else null,
			"normal": _serialize(hit.normal) if not hit.is_empty() else null,
			"shape": int(hit.get("shape", -1)) if not hit.is_empty() else null,
			"faceIndex": int(hit.get("face_index", -1)) if not hit.is_empty() else null,
		}


	func _resolve_camera_3d(params: Dictionary) -> Dictionary:
		var camera_path := str(params.get("cameraPath", ""))
		var camera: Camera3D = null
		if not camera_path.is_empty():
			var node := _node_at_path(camera_path)
			if not node is Camera3D:
				return _failure("RUNTIME_3D_CAMERA_INVALID", "cameraPath must resolve to a Camera3D.", {"cameraPath": camera_path})
			camera = node as Camera3D
		else:
			camera = get_viewport().get_camera_3d()
		if camera == null or not camera.is_inside_tree():
			return _failure("RUNTIME_3D_CAMERA_UNAVAILABLE", "No active Camera3D is available in the root viewport.")
		return {"camera": camera}


	func _decode_vector3(value: Variant) -> Dictionary:
		if typeof(value) != TYPE_DICTIONARY or value.size() != 3 or not value.has("x") or not value.has("y") or not value.has("z"):
			return _failure("RUNTIME_3D_WORLD_POSITION_INVALID", "worldPosition must contain numeric x, y, and z values.")
		for coordinate in ["x", "y", "z"]:
			var coordinate_type := typeof(value[coordinate])
			if coordinate_type != TYPE_INT and coordinate_type != TYPE_FLOAT:
				return _failure("RUNTIME_3D_WORLD_POSITION_INVALID", "worldPosition values must be numbers.", {"coordinate": coordinate})
		var vector := Vector3(float(value.x), float(value.y), float(value.z))
		if not vector.is_finite():
			return _failure("RUNTIME_3D_WORLD_POSITION_INVALID", "worldPosition values must be finite numbers.")
		return {"value": vector}


	func _acquire_exclusive_operation(peer: PeerState, deadline_ms: int) -> bool:
		while _exclusive_operation_active:
			if not _request_is_active(peer, deadline_ms):
				return false
			await get_tree().process_frame
		if not _request_is_active(peer, deadline_ms):
			return false
		_exclusive_operation_active = true
		return true


	func _release_exclusive_operation() -> void:
		_exclusive_operation_active = false


	func _request_is_active(peer: PeerState, deadline_ms: int) -> bool:
		if Time.get_ticks_msec() >= deadline_ms or peer.stream == null:
			return false
		peer.stream.poll()
		return peer.stream.get_status() == StreamPeerTCP.STATUS_CONNECTED


	func _request_cancelled(details: Dictionary = {}) -> Dictionary:
		return _failure("RUNTIME_REQUEST_CANCELLED", "The runtime request expired or its client disconnected before completion.", details)


	func _wait_request_delay(milliseconds: int, peer: PeerState, deadline_ms: int) -> bool:
		var delay_end_ms := Time.get_ticks_msec() + milliseconds
		while Time.get_ticks_msec() < delay_end_ms:
			if not _request_is_active(peer, deadline_ms):
				return false
			await get_tree().process_frame
		return _request_is_active(peer, deadline_ms)


	func _collect_controls(node: Node, selector: Dictionary, limit: int, elements: Array[Dictionary], budget: Array[int]) -> int:
		if budget[0] <= 0:
			return 0
		budget[0] -= 1
		var matches := 0
		if node is Control:
			var control := node as Control
			if _control_matches(control, selector):
				matches += 1
				if elements.size() < limit:
					elements.append(_describe_control(control))
		for child in node.get_children():
			matches += _collect_controls(child, selector, limit, elements, budget)
		return matches


	func _control_matches(control: Control, selector: Dictionary) -> bool:
		if bool(selector.get("visibleOnly", true)) and not control.is_visible_in_tree():
			return false
		var path_filter := str(selector.get("path", ""))
		if not path_filter.is_empty() and str(control.get_path()) != path_filter:
			return false
		var type_filter := str(selector.get("type", ""))
		if not type_filter.is_empty() and not control.is_class(type_filter):
			return false
		var text_filter := str(selector.get("text", ""))
		if not text_filter.is_empty() and _control_text(control).findn(text_filter) < 0:
			return false
		return true


	func _describe_control(control: Control) -> Dictionary:
		var rect := control.get_global_rect()
		var text := _control_text(control).left(512)
		return {
			"path": str(control.get_path()),
			"name": str(control.name),
			"type": control.get_class(),
			"text": text if not text.is_empty() else null,
			"visible": control.is_visible_in_tree(),
			"disabled": (control as BaseButton).disabled if control is BaseButton else null,
			"rect": {
				"x": rect.position.x,
				"y": rect.position.y,
				"width": rect.size.x,
				"height": rect.size.y,
				"centerX": rect.get_center().x,
				"centerY": rect.get_center().y,
			},
		}


	func _control_text(control: Control) -> String:
		if control is Button:
			return (control as Button).text
		if control is Label:
			return (control as Label).text
		if control is LineEdit:
			return (control as LineEdit).text
		if control is TextEdit:
			return (control as TextEdit).text
		if control is RichTextLabel:
			return (control as RichTextLabel).text
		return ""


	func _inject_input(params: Dictionary, peer: PeerState, deadline_ms: int) -> Dictionary:
		var kind := str(params.get("kind", ""))
		match kind:
			"click":
				var target: Control = null
				var path := str(params.get("path", ""))
				if not path.is_empty():
					target = _control_at_path(path)
					if target == null:
						return _failure("RUNTIME_INPUT_TARGET_NOT_FOUND", "UI target was not found.", {"path": path})
					if not target.is_visible_in_tree():
						return _failure("RUNTIME_INPUT_TARGET_HIDDEN", "UI target is not visible.", {"path": path})
				var position := target.get_global_rect().get_center() if target != null else Vector2(
					float(params.get("x", 0.0)), float(params.get("y", 0.0))
				)
				var motion := InputEventMouseMotion.new()
				motion.position = position
				motion.global_position = position
				Input.parse_input_event(motion)
				var button := clampi(int(params.get("button", MOUSE_BUTTON_LEFT)), MOUSE_BUTTON_LEFT, MOUSE_BUTTON_XBUTTON2)
				for pressed in [true, false]:
					var event := InputEventMouseButton.new()
					event.button_index = button
					event.pressed = pressed
					event.position = position
					event.global_position = position
					Input.parse_input_event(event)
				await get_tree().process_frame
				await get_tree().process_frame
				return {"delivered": true, "target": str(target.get_path()) if target != null else null, "x": position.x, "y": position.y}
			"action":
				var action := str(params.get("action", ""))
				if action.is_empty() or not InputMap.has_action(action):
					return _failure("RUNTIME_INPUT_ACTION_UNKNOWN", "InputMap action does not exist.", {"action": action})
				Input.action_press(action, clampf(float(params.get("strength", 1.0)), 0.0, 1.0))
				var action_hold := clampi(int(params.get("holdMs", 0)), 0, 2000)
				if action_hold > 0:
					var action_completed := await _wait_request_delay(action_hold, peer, deadline_ms)
					Input.action_release(action)
					if not action_completed:
						return _request_cancelled()
				else:
					await get_tree().process_frame
					Input.action_release(action)
					if not _request_is_active(peer, deadline_ms):
						return _request_cancelled()
				await get_tree().process_frame
				return {"delivered": true, "target": action}
			"key":
				var keycode := int(params.get("keycode", 0))
				if keycode <= 0:
					return _failure("RUNTIME_INPUT_KEY_INVALID", "keycode must be positive.")
				var press := InputEventKey.new()
				press.keycode = keycode
				press.physical_keycode = keycode
				press.pressed = true
				Input.parse_input_event(press)
				var key_hold := clampi(int(params.get("holdMs", 0)), 0, 2000)
				if key_hold > 0:
					var key_completed := await _wait_request_delay(key_hold, peer, deadline_ms)
					if not key_completed:
						var cancelled_release := InputEventKey.new()
						cancelled_release.keycode = keycode
						cancelled_release.physical_keycode = keycode
						cancelled_release.pressed = false
						Input.parse_input_event(cancelled_release)
						return _request_cancelled()
				else:
					await get_tree().process_frame
				var release := InputEventKey.new()
				release.keycode = keycode
				release.physical_keycode = keycode
				release.pressed = false
				Input.parse_input_event(release)
				await get_tree().process_frame
				return {"delivered": true, "target": str(keycode)}
			_:
				return _failure("RUNTIME_INPUT_KIND_UNKNOWN", "Input kind must be click, action, or key.")


	func _inject_input_sequence(params: Dictionary, peer: PeerState, deadline_ms: int) -> Dictionary:
		if get_tree().paused:
			return _failure("RUNTIME_INPUT_SEQUENCE_PAUSED", "Resume the SceneTree before injecting an input sequence.")
		var raw_steps = params.get("steps", [])
		if typeof(raw_steps) != TYPE_ARRAY or raw_steps.is_empty() or raw_steps.size() > 32:
			return _failure("RUNTIME_INPUT_SEQUENCE_INVALID", "steps must contain between 1 and 32 input objects.")
		var total_delay_ms := 0
		for index in range(raw_steps.size()):
			if typeof(raw_steps[index]) != TYPE_DICTIONARY:
				return _failure("RUNTIME_INPUT_SEQUENCE_INVALID", "Every sequence step must be an object.", {"index": index})
			var step: Dictionary = raw_steps[index]
			if str(step.get("kind", "")) not in ["click", "action", "key"]:
				return _failure("RUNTIME_INPUT_SEQUENCE_KIND_INVALID", "Sequence step kind must be click, action, or key.", {"index": index})
			var hold_ms := int(step.get("holdMs", 0))
			var after_ms := int(step.get("afterMs", 0))
			if hold_ms < 0 or hold_ms > 2000 or after_ms < 0 or after_ms > 1000:
				return _failure("RUNTIME_INPUT_SEQUENCE_DURATION_INVALID", "holdMs must be 0-2000 and afterMs must be 0-1000.", {"index": index})
			total_delay_ms += hold_ms + after_ms
		if total_delay_ms > 5000:
			return _failure("RUNTIME_INPUT_SEQUENCE_TOO_LONG", "Combined hold and delay duration exceeds 5 seconds.", {"totalDelayMs": total_delay_ms})
		var results: Array[Dictionary] = []
		var started := Time.get_ticks_msec()
		for index in range(raw_steps.size()):
			var step: Dictionary = raw_steps[index]
			var result := await _inject_input(step, peer, deadline_ms)
			if result.has("_error"):
				return _failure("RUNTIME_INPUT_SEQUENCE_STEP_FAILED", "An input sequence step failed.", {"index": index, "completed": results.size(), "cause": result._error})
			result["kind"] = str(step.get("kind", ""))
			results.append(result)
			var after_ms := int(step.get("afterMs", 0))
			if after_ms > 0:
				if not await _wait_request_delay(after_ms, peer, deadline_ms):
					return _request_cancelled({"completed": results.size()})
		return {
			"delivered": true,
			"completed": results.size(),
			"elapsedMs": Time.get_ticks_msec() - started,
			"results": results,
		}


	func _assert_state(params: Dictionary) -> Dictionary:
		var kind := str(params.get("kind", ""))
		if kind == "ui_exists":
			var selector = params.get("selector", {})
			if typeof(selector) != TYPE_DICTIONARY:
				return _failure("RUNTIME_SELECTOR_INVALID", "selector must be an object.")
			var elements: Array[Dictionary] = []
			var budget: Array[int] = [10000]
			var count := _collect_controls(get_tree().root, selector, 10, elements, budget)
			var expected := bool(params.get("expected", true))
			var actual := count > 0
			return {
				"passed": actual == expected,
				"assertion": "ui_exists",
				"expected": expected,
				"actual": actual,
				"evidence": {"count": count, "elements": elements, "scanTruncated": budget[0] <= 0},
			}
		if kind == "property":
			var node_path := str(params.get("nodePath", ""))
			var property := str(params.get("property", ""))
			var node := _node_at_path(node_path)
			if node == null:
				return {
					"passed": false,
					"assertion": "property",
					"expected": params.get("expected"),
					"actual": null,
					"evidence": {"nodeFound": false, "nodePath": node_path},
				}
			var found := node.has_meta(property.trim_prefix("meta:")) if property.begins_with("meta:") else _has_property(node, property)
			var actual = node.get_meta(property.trim_prefix("meta:"), null) if property.begins_with("meta:") else node.get(property) if found else null
			var expected = params.get("expected")
			var operator := str(params.get("operator", "equals"))
			var serialized_actual = _serialize(actual)
			return {
				"passed": found and _compare(serialized_actual, expected, operator),
				"assertion": "property:%s:%s" % [node_path, property],
				"expected": expected,
				"actual": serialized_actual,
				"evidence": {"nodeFound": true, "propertyFound": found, "operator": operator},
			}
		return _failure("RUNTIME_ASSERTION_KIND_UNKNOWN", "Assertion kind must be ui_exists or property.")


	func _wait_for_state(params: Dictionary) -> Dictionary:
		var timeout_ms := clampi(int(params.get("waitTimeoutMs", 1000)), 0, 30000)
		var poll_frames := clampi(int(params.get("pollEveryFrames", 1)), 1, 60)
		var started := Time.get_ticks_msec()
		var attempts := 0
		while true:
			attempts += 1
			var observation := _assert_state(params)
			if observation.has("_error"):
				return observation
			var elapsed := Time.get_ticks_msec() - started
			if bool(observation.passed) or elapsed >= timeout_ms:
				return {
					"satisfied": bool(observation.passed),
					"timedOut": not bool(observation.passed),
					"elapsedMs": elapsed,
					"attempts": attempts,
					"assertion": observation.assertion,
					"expected": observation.expected,
					"actual": observation.actual,
					"evidence": observation.evidence,
				}
			for _frame in range(poll_frames):
				await get_tree().process_frame
		return _failure("RUNTIME_WAIT_ABORTED", "Runtime wait ended unexpectedly.")


	func _control_runtime(params: Dictionary, peer: PeerState, deadline_ms: int) -> Dictionary:
		var action := str(params.get("action", ""))
		var tree := get_tree()
		var started := Time.get_ticks_msec()
		var before_frames := Engine.get_process_frames()
		var before_physics_frames := tree.get_frame()
		var requested_frames := 0
		match action:
			"pause":
				tree.paused = true
			"resume":
				tree.paused = false
			"step":
				if not tree.paused:
					return _failure("RUNTIME_STEP_REQUIRES_PAUSE", "Pause the scene tree before stepping frames.")
				requested_frames = int(params.get("frames", 1))
				if requested_frames < 1 or requested_frames > 120:
					return _failure("RUNTIME_STEP_FRAMES_INVALID", "frames must be between 1 and 120.", {"frames": requested_frames})
				tree.paused = false
				# process_frame fires immediately before Node._process. Waiting for one
				# extra signal lets exactly requested_frames process callbacks complete
				# before pausing the tree again.
				for _frame in range(requested_frames + 1):
					await tree.process_frame
					if not _request_is_active(peer, deadline_ms):
						tree.paused = true
						return _request_cancelled({"framesCompleted": _frame})
				tree.paused = true
			"step_physics":
				if not tree.paused:
					return _failure("RUNTIME_STEP_REQUIRES_PAUSE", "Pause the scene tree before stepping physics frames.")
				requested_frames = int(params.get("frames", 1))
				if requested_frames < 1 or requested_frames > 120:
					return _failure("RUNTIME_STEP_FRAMES_INVALID", "frames must be between 1 and 120.", {"frames": requested_frames})
				tree.paused = false
				for _frame in range(requested_frames + 1):
					await tree.physics_frame
					if not _request_is_active(peer, deadline_ms):
						tree.paused = true
						return _request_cancelled({"framesCompleted": _frame})
				tree.paused = true
			_:
				return _failure("RUNTIME_CONTROL_ACTION_UNKNOWN", "Control action must be pause, resume, step, or step_physics.")
		return {
			"action": action,
			"paused": tree.paused,
			"framesRequested": requested_frames,
			"processFramesAdvanced": Engine.get_process_frames() - before_frames,
			"physicsFramesAdvanced": tree.get_frame() - before_physics_frames,
			"elapsedMs": Time.get_ticks_msec() - started,
		}


	func _compare(actual: Variant, expected: Variant, operator: String) -> bool:
		match operator:
			"equals": return actual == expected
			"not_equals": return actual != expected
			"gt", "gte", "lt", "lte":
				if not (typeof(actual) in [TYPE_INT, TYPE_FLOAT] and typeof(expected) in [TYPE_INT, TYPE_FLOAT]):
					return false
				if operator == "gt": return actual > expected
				if operator == "gte": return actual >= expected
				if operator == "lt": return actual < expected
				return actual <= expected
			"contains":
				if typeof(actual) == TYPE_STRING:
					return str(actual).contains(str(expected))
				if typeof(actual) == TYPE_ARRAY or typeof(actual) == TYPE_DICTIONARY:
					return expected in actual
		return false


	func _control_at_path(path: String) -> Control:
		var node := _node_at_path(path)
		return node as Control if node is Control else null


	func _node_at_path(path: String) -> Node:
		if path.is_empty():
			return null
		if path.begins_with("/root/"):
			return get_tree().root.get_node_or_null(NodePath(path.trim_prefix("/root/")))
		return get_tree().root.get_node_or_null(NodePath(path))


	func _has_property(object: Object, property: String) -> bool:
		for descriptor in object.get_property_list():
			if str(descriptor.name) == property:
				return true
		return false


	func _serialize(value: Variant, depth: int = 0) -> Variant:
		if depth >= 8:
			return "<max-depth>"
		match typeof(value):
			TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT:
				return value
			TYPE_STRING:
				return str(value).left(4096)
			TYPE_VECTOR2:
				return {"x": value.x, "y": value.y}
			TYPE_VECTOR3:
				return {"x": value.x, "y": value.y, "z": value.z}
			TYPE_COLOR:
				return {"r": value.r, "g": value.g, "b": value.b, "a": value.a}
			TYPE_ARRAY:
				var array := []
				for index in range(mini(value.size(), 100)):
					array.append(_serialize(value[index], depth + 1))
				return array
			TYPE_DICTIONARY:
				var dictionary := {}
				var keys: Array = value.keys()
				for index in range(mini(keys.size(), 100)):
					var key = keys[index]
					dictionary[str(key)] = _serialize(value[key], depth + 1)
				return dictionary
			_:
				return str(value)


	func _constant_time_equal(left: String, right: String) -> bool:
		var left_bytes := left.to_utf8_buffer()
		var right_bytes := right.to_utf8_buffer()
		var difference := left_bytes.size() ^ right_bytes.size()
		var length := maxi(left_bytes.size(), right_bytes.size())
		for index in range(length):
			var left_value := left_bytes[index] if index < left_bytes.size() else 0
			var right_value := right_bytes[index] if index < right_bytes.size() else 0
			difference |= left_value ^ right_value
		return difference == 0


	func _failure(code: String, message: String, details: Dictionary = {}) -> Dictionary:
		return {"_error": {"code": code, "message": message, "details": details}}


	func _send_error(peer: PeerState, code: String, message: String, request_id: String, details: Dictionary = {}) -> void:
		_send(peer, {"id": request_id, "ok": false, "error": {"code": code, "message": message, "details": details}})


	func _send(peer: PeerState, response: Dictionary) -> void:
		var bytes := (JSON.stringify(response) + "\n").to_utf8_buffer()
		if peer.stream == null:
			return
		peer.stream.poll()
		if peer.stream.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			return
		if bytes.size() > MAX_MESSAGE_BYTES:
			var request_id := str(response.get("id", ""))
			bytes = (JSON.stringify({
				"id": request_id,
				"ok": false,
				"error": {
					"code": "RUNTIME_RESPONSE_TOO_LARGE",
					"message": "Runtime bridge response exceeded 1 MiB.",
					"details": {"bytes": bytes.size(), "maxBytes": MAX_MESSAGE_BYTES},
				},
			}) + "\n").to_utf8_buffer()
		peer.stream.put_data(bytes)


	func _exit_tree() -> void:
		for peer in _peers:
			if peer.stream != null:
				peer.stream.disconnect_from_host()
		_peers.clear()
		if _server != null:
			_server.stop()


func _initialize() -> void:
	var bridge := RuntimeBridge.new()
	bridge.name = "GodotAgentRuntimeBridge"
	root.add_child(bridge)

	var scene_path := OS.get_environment("GODOT_AGENT_RUNTIME_SCENE")
	if scene_path.is_empty():
		scene_path = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if scene_path.is_empty():
		push_error("GODOT_AGENT_RUNTIME_SCENE_MISSING")
		quit(66)
		return
	var packed = load(scene_path)
	if not packed is PackedScene:
		push_error("GODOT_AGENT_RUNTIME_SCENE_LOAD_FAILED:%s" % scene_path)
		quit(65)
		return
	var scene := (packed as PackedScene).instantiate()
	root.add_child(scene)
	current_scene = scene


func _finalize() -> void:
	pass
