extends SceneTree

const PROTOCOL_VERSION := "0.1.0"
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
		var result: Dictionary = await _dispatch(command, params)
		if result.has("_error"):
			var failure: Dictionary = result["_error"]
			_send_error(peer, str(failure.code), str(failure.message), request_id, failure.get("details", {}))
			return
		_send(peer, {"id": request_id, "ok": true, "result": result})


	func _dispatch(command: String, params: Dictionary) -> Dictionary:
		match command:
			"hello":
				return {
					"protocolVersion": PROTOCOL_VERSION,
					"engineVersion": Engine.get_version_info().get("string", "unknown"),
					"scene": get_tree().current_scene.scene_file_path if get_tree().current_scene != null else null,
					"capabilities": ["screenshot", "ui", "scene_tree", "node", "input", "input_sequence", "assert", "wait", "control"],
				}
			"screenshot":
				return await _capture_screenshot()
			"ui_find":
				return _find_ui(params)
			"scene_tree":
				return _scene_tree(params)
			"node_get":
				return _node_get(params)
			"input":
				return await _inject_input(params)
			"input_sequence":
				return await _inject_input_sequence(params)
			"assert":
				return _assert_state(params)
			"wait":
				return await _wait_for_state(params)
			"control":
				return await _control_runtime(params)
			_:
				return _failure("RUNTIME_COMMAND_UNKNOWN", "Unknown runtime command: %s" % command)


	func _capture_screenshot() -> Dictionary:
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
		return {
			"path": path.replace("\\", "/"),
			"width": image.get_width(),
			"height": image.get_height(),
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


	func _inject_input(params: Dictionary) -> Dictionary:
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
					await get_tree().create_timer(float(action_hold) / 1000.0).timeout
				else:
					await get_tree().process_frame
				Input.action_release(action)
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
					await get_tree().create_timer(float(key_hold) / 1000.0).timeout
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


	func _inject_input_sequence(params: Dictionary) -> Dictionary:
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
			var result := await _inject_input(step)
			if result.has("_error"):
				return _failure("RUNTIME_INPUT_SEQUENCE_STEP_FAILED", "An input sequence step failed.", {"index": index, "completed": results.size(), "cause": result._error})
			result["kind"] = str(step.get("kind", ""))
			results.append(result)
			var after_ms := int(step.get("afterMs", 0))
			if after_ms > 0:
				await get_tree().create_timer(float(after_ms) / 1000.0).timeout
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


	func _control_runtime(params: Dictionary) -> Dictionary:
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
		if bytes.size() <= MAX_MESSAGE_BYTES and peer.stream != null:
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
