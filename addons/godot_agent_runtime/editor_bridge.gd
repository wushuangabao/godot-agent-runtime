@tool
extends Node

const PROTOCOL_VERSION := "0.3.0"
const MAX_MESSAGE_BYTES := 1024 * 1024

var _editor: EditorInterface
var _undo_redo: EditorUndoRedoManager
var _server: TCPServer
var _port := 0
var _token := ""
var _run_id := ""
var _peers: Array[Dictionary] = []


func configure(editor: EditorInterface, undo_redo: EditorUndoRedoManager) -> void:
	_editor = editor
	_undo_redo = undo_redo


func _ready() -> void:
	_port = int(OS.get_environment("GODOT_AGENT_RUNTIME_PORT"))
	_token = OS.get_environment("GODOT_AGENT_RUNTIME_TOKEN")
	_run_id = OS.get_environment("GODOT_AGENT_RUNTIME_RUN_ID")
	if _editor == null or _undo_redo == null or _port < 1 or _token.is_empty() or _run_id.is_empty():
		push_error("GODOT_AGENT_EDITOR_BRIDGE_CONFIG_INVALID")
		return
	_server = TCPServer.new()
	var error := _server.listen(_port, "127.0.0.1")
	if error != OK:
		push_error("GODOT_AGENT_EDITOR_BRIDGE_LISTEN_FAILED:%d" % error)
		return
	print("GODOT_AGENT_EDITOR_BRIDGE_READY:%s:%d" % [_run_id, _port])


func _process(_delta: float) -> void:
	if _server == null or not _server.is_listening():
		return
	while _server.is_connection_available():
		var stream := _server.take_connection()
		if stream == null:
			break
		stream.set_no_delay(true)
		_peers.append({"stream": stream, "buffer": PackedByteArray(), "handled": false})

	var index := _peers.size() - 1
	while index >= 0:
		var peer: Dictionary = _peers[index]
		var stream: StreamPeerTCP = peer.stream
		stream.poll()
		if stream.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			_peers.remove_at(index)
			index -= 1
			continue
		if not peer.handled:
			var available := stream.get_available_bytes()
			if available > 0:
				var received := stream.get_partial_data(available)
				if received[0] == OK:
					peer.buffer.append_array(received[1])
			if peer.buffer.size() > MAX_MESSAGE_BYTES:
				_send(peer, {"id": "", "ok": false, "error": {"code": "EDITOR_REQUEST_TOO_LARGE", "message": "Request exceeded 1 MiB."}})
			elif peer.buffer.find(10) >= 0:
				peer.handled = true
				_handle(peer, peer.buffer.slice(0, peer.buffer.find(10)).get_string_from_utf8())
		index -= 1


func _handle(peer: Dictionary, line: String) -> void:
	var parsed = JSON.parse_string(line)
	if typeof(parsed) != TYPE_DICTIONARY:
		_send(peer, {"id": "", "ok": false, "error": {"code": "EDITOR_REQUEST_INVALID", "message": "Request must be a JSON object."}})
		return
	var request: Dictionary = parsed
	var request_id := str(request.get("id", ""))
	if request_id.is_empty() or str(request.get("token", "")) != _token:
		_send(peer, {"id": request_id, "ok": false, "error": {"code": "EDITOR_UNAUTHORIZED", "message": "Invalid request id or token."}})
		return
	var command := str(request.get("command", ""))
	var params = request.get("params", {})
	if typeof(params) != TYPE_DICTIONARY:
		_send(peer, {"id": request_id, "ok": false, "error": {"code": "EDITOR_REQUEST_INVALID", "message": "params must be an object."}})
		return
	match command:
		"hello":
			var root := _editor.get_edited_scene_root()
			_send_ok(peer, request_id, {
				"protocolVersion": PROTOCOL_VERSION,
				"engineVersion": Engine.get_version_info().get("string", "unknown"),
				"scene": root.scene_file_path if root != null else null,
				"capabilities": ["scene_tree", "selection", "screenshot", "viewport_3d", "node_edit", "scene_instantiate", "scene_inheritance", "instance_editable", "resource_edit", "resource_save", "resource_focus", "signal_connect", "scene_save", "undo_redo"],
			})
		"scene_tree":
			var root := _editor.get_edited_scene_root()
			var budget: Array[int] = [2000]
			_send_ok(peer, request_id, {
				"root": _describe_tree(root, 0, budget) if root != null else null,
				"truncated": budget[0] <= 0,
			})
		"selection":
			_send_ok(peer, request_id, _selection_get())
		"selection_set":
			_send_ok(peer, request_id, _selection_set(params))
		"screenshot":
			_send_ok(peer, request_id, await _screenshot(params))
		"node_get":
			_send_ok(peer, request_id, _node_get(params))
		"node_create":
			_send_ok(peer, request_id, _node_create(params))
		"scene_instantiate":
			_send_ok(peer, request_id, _scene_instantiate(params))
		"scene_create_inherited":
			_send_ok(peer, request_id, await _scene_create_inherited(params))
		"node_update":
			_send_ok(peer, request_id, _node_update(params))
		"node_delete":
			_send_ok(peer, request_id, _node_delete(params))
		"node_move":
			_send_ok(peer, request_id, _node_move(params))
		"resource_create":
			_send_ok(peer, request_id, _resource_create(params))
		"resource_get":
			_send_ok(peer, request_id, _resource_get(params))
		"resource_update":
			_send_ok(peer, request_id, _resource_update(params))
		"resource_save":
			_send_ok(peer, request_id, _resource_save(params))
		"resource_focus":
			_send_ok(peer, request_id, _resource_focus(params))
		"instance_get":
			_send_ok(peer, request_id, _instance_get(params))
		"instance_set_editable":
			_send_ok(peer, request_id, _instance_set_editable(params))
		"signal_connect":
			_send_ok(peer, request_id, _signal_connect(params))
		"scene_save":
			_send_ok(peer, request_id, _scene_save())
		"history_undo":
			_send_ok(peer, request_id, _history_step("undo"))
		"history_redo":
			_send_ok(peer, request_id, _history_step("redo"))
		_:
			_send(peer, {"id": request_id, "ok": false, "error": {"code": "EDITOR_COMMAND_UNKNOWN", "message": "Unknown editor command."}})


func _describe_tree(node: Node, depth: int, budget: Array[int]) -> Dictionary:
	budget[0] -= 1
	var children: Array[Dictionary] = []
	if depth < 64 and budget[0] > 0:
		for child in node.get_children():
			if budget[0] <= 0:
				break
			children.append(_describe_tree(child, depth + 1, budget))
	return {
		"path": _logical_path(node),
		"name": str(node.name),
		"type": node.get_class(),
		"owner": _logical_path(node.owner) if node.owner != null else null,
		"children": children,
	}


func _node_get(params: Dictionary) -> Dictionary:
	var path := str(params.get("nodePath", ""))
	var node := _node_at_path(path)
	if node == null:
		return _failure("EDITOR_NODE_NOT_FOUND", "Node was not found in the edited scene.", {"nodePath": path})
	var requested = params.get("properties", [])
	if typeof(requested) != TYPE_ARRAY or requested.size() > 100:
		return _failure("EDITOR_PROPERTIES_INVALID", "properties must be an array with at most 100 names.")
	var values := {}
	for property_value in requested:
		var property := str(property_value)
		if _property_descriptor(node, property).is_empty():
			return _failure("EDITOR_PROPERTY_NOT_FOUND", "Node property does not exist.", {"nodePath": path, "property": property})
		values[property] = _encode_value(node.get(property))
	return {"node": _describe_node(node, values)}


func _node_create(params: Dictionary) -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _failure("EDITOR_SCENE_NOT_OPEN", "No edited scene is open.")
	var parent_path := str(params.get("parentPath", ""))
	var parent := _node_at_path(parent_path)
	if parent == null:
		return _failure("EDITOR_PARENT_NOT_FOUND", "Parent node was not found.", {"parentPath": parent_path})
	var type_name := str(params.get("type", ""))
	if type_name.is_empty() or not ClassDB.class_exists(type_name) or not ClassDB.can_instantiate(type_name) or not ClassDB.is_parent_class(type_name, "Node"):
		return _failure("EDITOR_NODE_TYPE_INVALID", "type must name an instantiable Node class.", {"type": type_name})
	var node_name := str(params.get("name", ""))
	var name_error := _validate_node_name(node_name)
	if not name_error.is_empty():
		return _failure("EDITOR_NODE_NAME_INVALID", name_error, {"name": node_name})
	if parent.has_node(NodePath(node_name)):
		return _failure("EDITOR_NODE_NAME_CONFLICT", "Parent already has a child with this name.", {"parentPath": parent_path, "name": node_name})
	var instance = ClassDB.instantiate(type_name)
	if not instance is Node:
		if instance != null:
			instance.free()
		return _failure("EDITOR_NODE_CREATE_FAILED", "Godot could not instantiate the requested Node type.", {"type": type_name})
	var node := instance as Node
	node.name = node_name
	var prepared := _prepare_properties(node, params.get("properties", {}))
	if prepared.has("_error"):
		node.free()
		return prepared

	_undo_redo.create_action("Agent: create %s" % node_name, UndoRedo.MERGE_DISABLE, root)
	_undo_redo.add_do_method(parent, "add_child", node, true)
	_undo_redo.add_do_method(node, "set_owner", root)
	for change in prepared.changes:
		_undo_redo.add_do_property(node, change.property, change.value)
	_undo_redo.add_do_reference(node)
	_undo_redo.add_undo_method(parent, "remove_child", node)
	_undo_redo.commit_action()
	return {
		"action": "create",
		"node": _describe_node(node, _encoded_properties(node, prepared.names)),
		"previousPath": null,
		"changedProperties": prepared.names,
		"undoable": true,
	}


func _scene_instantiate(params: Dictionary) -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _failure("EDITOR_SCENE_NOT_OPEN", "No edited scene is open.")
	var parent_path := str(params.get("parentPath", ""))
	var parent := _node_at_path(parent_path)
	if parent == null:
		return _failure("EDITOR_PARENT_NOT_FOUND", "Parent node was not found.", {"parentPath": parent_path})
	var checked_path := _validated_res_path(str(params.get("scenePath", "")), ["tscn"])
	if checked_path.has("_error"):
		return checked_path
	var scene_path: String = checked_path.path
	if not FileAccess.file_exists(scene_path):
		return _failure("EDITOR_SCENE_RESOURCE_NOT_FOUND", "PackedScene file was not found.", {"scenePath": scene_path})
	var packed = load(scene_path)
	if not packed is PackedScene or not (packed as PackedScene).can_instantiate():
		return _failure("EDITOR_PACKED_SCENE_INVALID", "The resource is not an instantiable PackedScene.", {"scenePath": scene_path})
	var instance := (packed as PackedScene).instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
	if instance == null:
		return _failure("EDITOR_SCENE_INSTANTIATE_FAILED", "Godot could not instantiate the PackedScene.", {"scenePath": scene_path})
	var requested_name = params.get("name", null)
	if requested_name != null:
		var name_error := _validate_node_name(str(requested_name))
		if not name_error.is_empty():
			instance.free()
			return _failure("EDITOR_NODE_NAME_INVALID", name_error, {"name": str(requested_name)})
		instance.name = str(requested_name)
	if parent.has_node(NodePath(str(instance.name))):
		var conflict_name := str(instance.name)
		instance.free()
		return _failure("EDITOR_NODE_NAME_CONFLICT", "Parent already has a child with this name.", {"parentPath": parent_path, "name": conflict_name})
	var prepared := _prepare_properties(instance, params.get("properties", {}))
	if prepared.has("_error"):
		instance.free()
		return prepared

	_undo_redo.create_action("Agent: instantiate %s" % instance.name, UndoRedo.MERGE_DISABLE, root)
	_undo_redo.add_do_method(parent, "add_child", instance, true)
	_undo_redo.add_do_method(instance, "set_owner", root)
	for change in prepared.changes:
		_undo_redo.add_do_property(instance, change.property, change.value)
	_undo_redo.add_do_reference(instance)
	_undo_redo.add_undo_method(parent, "remove_child", instance)
	_undo_redo.commit_action()
	return {
		"action": "instantiate",
		"node": _describe_node(instance, _encoded_properties(instance, prepared.names)),
		"previousPath": null,
		"scenePath": scene_path,
		"changedProperties": prepared.names,
		"undoable": true,
	}


func _scene_create_inherited(params: Dictionary) -> Dictionary:
	var checked_source := _validated_res_path(str(params.get("sourceScenePath", "")), ["tscn"])
	if checked_source.has("_error"):
		return checked_source
	var checked_target := _validated_res_path(str(params.get("targetScenePath", "")), ["tscn"])
	if checked_target.has("_error"):
		return checked_target
	var source_path: String = checked_source.path
	var target_path: String = checked_target.path
	if source_path == target_path:
		return _failure("EDITOR_INHERITED_SCENE_PATH_CONFLICT", "The inherited scene target must differ from its source.", {"path": source_path})
	if not FileAccess.file_exists(source_path):
		return _failure("EDITOR_SCENE_RESOURCE_NOT_FOUND", "Inherited scene source was not found.", {"sourceScenePath": source_path})
	var overwrite := bool(params.get("overwrite", false))
	var target_exists := FileAccess.file_exists(target_path)
	if target_exists and not overwrite:
		return _failure("EDITOR_INHERITED_SCENE_EXISTS", "Inherited scene target already exists and overwrite is false.", {"targetScenePath": target_path})
	var source = load(source_path)
	if not source is PackedScene or not (source as PackedScene).can_instantiate():
		return _failure("EDITOR_PACKED_SCENE_INVALID", "The inherited scene source is not an instantiable PackedScene.", {"sourceScenePath": source_path})

	var previous_root := _editor.get_edited_scene_root()
	var previous_scene := previous_root.scene_file_path if previous_root != null else ""
	if previous_root != null and previous_scene.is_empty():
		return _failure("EDITOR_CURRENT_SCENE_UNSAVED", "Save or close the current untitled scene before creating an inherited scene.")
	# This is the same standard API path used by Scene > New Inherited Scene.
	# It attaches the internal SceneState that is intentionally not exposed as a
	# public Node method, then save_scene_as serializes the true base-scene link.
	_editor.open_scene_from_path(source_path, true)
	var inherited_root := _editor.get_edited_scene_root()
	if inherited_root == null or not inherited_root.scene_file_path.is_empty():
		await _restore_or_close_edited_scene(previous_scene)
		return _failure("EDITOR_INHERITED_SCENE_INSTANTIATE_FAILED", "Godot could not open a new inherited scene from the source.", {"sourceScenePath": source_path})

	var requested_name = params.get("rootName", null)
	if requested_name != null:
		var name_error := _validate_node_name(str(requested_name))
		if not name_error.is_empty():
			await _restore_or_close_edited_scene(previous_scene)
			return _failure("EDITOR_NODE_NAME_INVALID", name_error, {"name": str(requested_name)})
		inherited_root.name = str(requested_name)
	var prepared := _prepare_properties(inherited_root, params.get("rootProperties", {}))
	if prepared.has("_error"):
		await _restore_or_close_edited_scene(previous_scene)
		return prepared
	for change in prepared.changes:
		inherited_root.set(change.property, change.value)
	var root_name := str(inherited_root.name)

	var directory_error := DirAccess.make_dir_recursive_absolute(str(checked_target.absolutePath).get_base_dir())
	if directory_error != OK:
		await _restore_or_close_edited_scene(previous_scene)
		return _failure("EDITOR_INHERITED_SCENE_DIRECTORY_FAILED", "Godot could not create the inherited scene target directory.", {"targetScenePath": target_path, "error": directory_error})
	_editor.save_scene_as(target_path, false)
	if inherited_root.scene_file_path != target_path or not FileAccess.file_exists(target_path):
		await _restore_or_close_edited_scene(previous_scene)
		return _failure("EDITOR_INHERITED_SCENE_SAVE_FAILED", "Godot could not save the inherited scene.", {"targetScenePath": target_path})
	_editor.get_resource_filesystem().scan()
	var requested_open := bool(params.get("open", false))
	if not requested_open:
		await _restore_or_close_edited_scene(previous_scene)
	var active_root := _editor.get_edited_scene_root()
	var open_scene := active_root != null and active_root.scene_file_path == target_path
	return {
		"created": true,
		"sourceScene": source_path,
		"targetScene": target_path,
		"rootName": root_name,
		"opened": open_scene,
		"overwritten": target_exists,
		"undoable": false,
	}


func _restore_or_close_edited_scene(scene_path: String) -> void:
	if scene_path.is_empty():
		_editor.close_scene()
	else:
		await _restore_edited_scene(scene_path)


func _restore_edited_scene(scene_path: String) -> bool:
	_editor.open_scene_from_path(scene_path)
	for _frame in range(120):
		await get_tree().process_frame
		var restored_root := _editor.get_edited_scene_root()
		if restored_root != null and restored_root.scene_file_path == scene_path:
			return true
	return false


func _node_update(params: Dictionary) -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _failure("EDITOR_SCENE_NOT_OPEN", "No edited scene is open.")
	var path := str(params.get("nodePath", ""))
	var node := _node_at_path(path)
	if node == null:
		return _failure("EDITOR_NODE_NOT_FOUND", "Node was not found in the edited scene.", {"nodePath": path})
	var new_name = params.get("name", null)
	if new_name != null:
		new_name = str(new_name)
		var name_error := _validate_node_name(new_name)
		if not name_error.is_empty():
			return _failure("EDITOR_NODE_NAME_INVALID", name_error, {"name": new_name})
		if node.get_parent() != null and new_name != str(node.name) and node.get_parent().has_node(NodePath(new_name)):
			return _failure("EDITOR_NODE_NAME_CONFLICT", "Parent already has a child with this name.", {"name": new_name})
	var prepared := _prepare_properties(node, params.get("properties", {}))
	if prepared.has("_error"):
		return prepared
	if new_name == null and prepared.names.is_empty():
		return _failure("EDITOR_UPDATE_EMPTY", "Update requires name or at least one property.")

	var old_name := node.name
	var name_changed: bool = new_name != null and new_name != str(node.name)
	_undo_redo.create_action("Agent: update %s" % node.name, UndoRedo.MERGE_DISABLE, root)
	if name_changed:
		_undo_redo.add_do_property(node, "name", new_name)
		_undo_redo.add_undo_property(node, "name", old_name)
	for change in prepared.changes:
		_undo_redo.add_do_property(node, change.property, change.value)
		_undo_redo.add_undo_property(node, change.property, change.previous)
	_undo_redo.commit_action()
	var changed_names: Array = prepared.names.duplicate()
	if name_changed:
		changed_names.push_front("name")
	return {
		"action": "update",
		"node": _describe_node(node, _encoded_properties(node, prepared.names)),
		"previousPath": path,
		"changedProperties": changed_names,
		"undoable": true,
	}


func _node_delete(params: Dictionary) -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _failure("EDITOR_SCENE_NOT_OPEN", "No edited scene is open.")
	var path := str(params.get("nodePath", ""))
	var node := _node_at_path(path)
	if node == null:
		return _failure("EDITOR_NODE_NOT_FOUND", "Node was not found in the edited scene.", {"nodePath": path})
	if node == root:
		return _failure("EDITOR_ROOT_DELETE_REJECTED", "The edited scene root cannot be deleted.")
	var parent := node.get_parent()
	if parent == null:
		return _failure("EDITOR_NODE_DELETE_FAILED", "Node has no parent.")
	var index := node.get_index()
	var owner := node.owner
	var description := _describe_node(node, {})

	_undo_redo.create_action("Agent: delete %s" % node.name, UndoRedo.MERGE_DISABLE, root)
	_undo_redo.add_do_method(parent, "remove_child", node)
	_undo_redo.add_undo_method(parent, "add_child", node, true)
	_undo_redo.add_undo_method(parent, "move_child", node, index)
	_undo_redo.add_undo_method(node, "set_owner", owner)
	_undo_redo.add_undo_reference(node)
	_undo_redo.commit_action()
	return {
		"action": "delete",
		"node": null,
		"deletedNode": description,
		"previousPath": path,
		"changedProperties": [],
		"undoable": true,
	}


func _node_move(params: Dictionary) -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _failure("EDITOR_SCENE_NOT_OPEN", "No edited scene is open.")
	var path := str(params.get("nodePath", ""))
	var parent_path := str(params.get("newParentPath", ""))
	var node := _node_at_path(path)
	var new_parent := _node_at_path(parent_path)
	if node == null:
		return _failure("EDITOR_NODE_NOT_FOUND", "Node was not found in the edited scene.", {"nodePath": path})
	if new_parent == null:
		return _failure("EDITOR_PARENT_NOT_FOUND", "New parent node was not found.", {"newParentPath": parent_path})
	if node == root:
		return _failure("EDITOR_ROOT_MOVE_REJECTED", "The edited scene root cannot be moved.")
	if node == new_parent or node.is_ancestor_of(new_parent):
		return _failure("EDITOR_MOVE_CYCLE", "A node cannot be moved below itself or one of its descendants.")
	var old_parent := node.get_parent()
	if old_parent == null:
		return _failure("EDITOR_NODE_MOVE_FAILED", "Node has no current parent.")
	if old_parent != new_parent and new_parent.has_node(NodePath(str(node.name))):
		return _failure("EDITOR_NODE_NAME_CONFLICT", "New parent already has a child with this name.", {"name": str(node.name)})
	var old_index := node.get_index()
	var requested_index := int(params.get("index", -1))
	var max_index := new_parent.get_child_count() if old_parent != new_parent else maxi(new_parent.get_child_count() - 1, 0)
	if requested_index < -1 or requested_index > max_index:
		return _failure("EDITOR_CHILD_INDEX_INVALID", "index is outside the new parent's child range.", {"index": requested_index, "maximum": max_index})
	var keep_global_transform := bool(params.get("keepGlobalTransform", true))

	_undo_redo.create_action("Agent: move %s" % node.name, UndoRedo.MERGE_DISABLE, root)
	if old_parent != new_parent:
		_undo_redo.add_do_method(node, "reparent", new_parent, keep_global_transform)
	if requested_index >= 0:
		_undo_redo.add_do_method(new_parent, "move_child", node, requested_index)
	if old_parent != new_parent:
		_undo_redo.add_undo_method(node, "reparent", old_parent, keep_global_transform)
	_undo_redo.add_undo_method(old_parent, "move_child", node, old_index)
	_undo_redo.commit_action()
	return {
		"action": "move",
		"node": _describe_node(node, {}),
		"previousPath": path,
		"previousParentPath": _logical_path(old_parent),
		"parentPath": _logical_path(new_parent),
		"index": node.get_index(),
		"changedProperties": [],
		"undoable": true,
	}


func _resource_create(params: Dictionary) -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _failure("EDITOR_SCENE_NOT_OPEN", "No edited scene is open.")
	var node_path := str(params.get("nodePath", ""))
	var property := str(params.get("property", ""))
	var type_name := str(params.get("type", ""))
	var node := _node_at_path(node_path)
	if node == null:
		return _failure("EDITOR_NODE_NOT_FOUND", "Node was not found in the edited scene.", {"nodePath": node_path})
	var target_descriptor := _property_descriptor(node, property)
	if target_descriptor.is_empty():
		return _failure("EDITOR_PROPERTY_NOT_FOUND", "Target resource property does not exist.", {"nodePath": node_path, "property": property})
	if int(target_descriptor.usage) & PROPERTY_USAGE_READ_ONLY or int(target_descriptor.type) != TYPE_OBJECT:
		return _failure("EDITOR_RESOURCE_PROPERTY_INVALID", "Target property must be a writable Object/Resource property.", {"property": property})
	if type_name.is_empty() or not ClassDB.class_exists(type_name) or not ClassDB.can_instantiate(type_name) or not ClassDB.is_parent_class(type_name, "Resource"):
		return _failure("EDITOR_RESOURCE_TYPE_INVALID", "type must name an instantiable Resource class.", {"type": type_name})
	var instance = ClassDB.instantiate(type_name)
	if not instance is Resource:
		return _failure("EDITOR_RESOURCE_CREATE_FAILED", "Godot could not instantiate the requested Resource type.", {"type": type_name})
	var resource := instance as Resource
	var required_class := _resource_class_from_descriptor(target_descriptor)
	if not required_class.is_empty() and not resource.is_class(required_class):
		return _failure("EDITOR_RESOURCE_CLASS_MISMATCH", "Resource type is incompatible with the target property.", {"type": type_name, "requiredClass": required_class, "property": property})
	var prepared := _prepare_properties(resource, params.get("properties", {}))
	if prepared.has("_error"):
		return prepared
	var previous = node.get(property)

	_undo_redo.create_action("Agent: create %s resource" % type_name, UndoRedo.MERGE_DISABLE, root)
	for change in prepared.changes:
		_undo_redo.add_do_property(resource, change.property, change.value)
	_undo_redo.add_do_property(node, property, resource)
	_undo_redo.add_do_reference(resource)
	_undo_redo.add_undo_property(node, property, previous)
	_undo_redo.commit_action()
	return {
		"action": "resource_create",
		"nodePath": node_path,
		"property": property,
		"resource": {
			"$type": "Resource",
			"path": resource.resource_path,
			"class": resource.get_class(),
			"properties": _encoded_properties(resource, prepared.names),
		},
		"changedProperties": prepared.names,
		"undoable": true,
	}


func _resource_get(params: Dictionary) -> Dictionary:
	var target := _resource_target(params)
	if target.has("_error"):
		return target
	var requested = params.get("properties", [])
	if typeof(requested) != TYPE_ARRAY or requested.size() > 100:
		return _failure("EDITOR_PROPERTIES_INVALID", "properties must be an array with at most 100 names.")
	var resource: Resource = target.resource
	var names: Array[String] = []
	for property_value in requested:
		var property := str(property_value)
		if _property_descriptor(resource, property).is_empty():
			return _failure("EDITOR_PROPERTY_NOT_FOUND", "Resource property does not exist.", {"nodePath": target.nodePath, "nodeProperty": target.property, "property": property})
		names.append(property)
	return {
		"nodePath": target.nodePath,
		"property": target.property,
		"resource": _describe_resource(resource, _encoded_properties(resource, names)),
	}


func _resource_update(params: Dictionary) -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _failure("EDITOR_SCENE_NOT_OPEN", "No edited scene is open.")
	var target := _resource_target(params)
	if target.has("_error"):
		return target
	var resource: Resource = target.resource
	var prepared := _prepare_properties(resource, params.get("properties", {}))
	if prepared.has("_error"):
		return prepared
	if prepared.names.is_empty():
		return _failure("EDITOR_UPDATE_EMPTY", "Resource update requires at least one property.")

	_undo_redo.create_action("Agent: update %s resource" % resource.get_class(), UndoRedo.MERGE_DISABLE, root)
	for change in prepared.changes:
		_undo_redo.add_do_property(resource, change.property, change.value)
		_undo_redo.add_undo_property(resource, change.property, change.previous)
	_undo_redo.commit_action()
	return {
		"action": "resource_update",
		"nodePath": target.nodePath,
		"property": target.property,
		"resource": _describe_resource(resource, _encoded_properties(resource, prepared.names)),
		"changedProperties": prepared.names,
		"undoable": true,
	}


func _resource_target(params: Dictionary) -> Dictionary:
	var node_path := str(params.get("nodePath", ""))
	var property := str(params.get("property", ""))
	var node := _node_at_path(node_path)
	if node == null:
		return _failure("EDITOR_NODE_NOT_FOUND", "Node was not found in the edited scene.", {"nodePath": node_path})
	if _property_descriptor(node, property).is_empty():
		return _failure("EDITOR_PROPERTY_NOT_FOUND", "Resource property does not exist.", {"nodePath": node_path, "property": property})
	var value = node.get(property)
	if not value is Resource:
		return _failure("EDITOR_RESOURCE_VALUE_REQUIRED", "The selected node property does not contain a Resource.", {"nodePath": node_path, "property": property})
	return {"nodePath": node_path, "property": property, "resource": value as Resource}


func _describe_resource(resource: Resource, properties: Dictionary) -> Dictionary:
	return {
		"$type": "Resource",
		"path": resource.resource_path,
		"class": resource.get_class(),
		"properties": properties,
	}


func _resource_save(params: Dictionary) -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _failure("EDITOR_SCENE_NOT_OPEN", "No edited scene is open.")
	var node_path := str(params.get("nodePath", ""))
	var property := str(params.get("property", ""))
	var node := _node_at_path(node_path)
	if node == null:
		return _failure("EDITOR_NODE_NOT_FOUND", "Node was not found in the edited scene.", {"nodePath": node_path})
	if _property_descriptor(node, property).is_empty():
		return _failure("EDITOR_PROPERTY_NOT_FOUND", "Resource property does not exist.", {"nodePath": node_path, "property": property})
	var value = node.get(property)
	if not value is Resource:
		return _failure("EDITOR_RESOURCE_VALUE_REQUIRED", "The selected node property does not contain a Resource.", {"nodePath": node_path, "property": property})
	var checked_path := _validated_res_path(str(params.get("path", "")), ["tres"])
	if checked_path.has("_error"):
		return checked_path
	var path: String = checked_path.path
	var overwrite := bool(params.get("overwrite", false))
	var existed := FileAccess.file_exists(path)
	if existed and not overwrite:
		return _failure("EDITOR_RESOURCE_FILE_EXISTS", "Resource path already exists and overwrite is false.", {"path": path})
	var parent_directory := path.get_base_dir()
	if not DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(parent_directory)):
		return _failure("EDITOR_RESOURCE_DIRECTORY_NOT_FOUND", "Resource parent directory does not exist.", {"path": path, "directory": parent_directory})
	var resource := value as Resource
	var previous_path := resource.resource_path
	var external = resource.duplicate(true)
	if not external is Resource:
		return _failure("EDITOR_RESOURCE_DUPLICATE_FAILED", "Godot could not duplicate the inline Resource before saving.", {"class": resource.get_class()})
	var external_resource := external as Resource
	external_resource.resource_scene_unique_id = ""
	var error := ResourceSaver.save(external_resource, path, ResourceSaver.FLAG_CHANGE_PATH)
	if error != OK:
		return _failure("EDITOR_RESOURCE_SAVE_FAILED", "Godot could not save the Resource.", {"path": path, "error": error})
	external_resource.take_over_path(path)
	_undo_redo.create_action("Agent: externalize %s resource" % node.name, UndoRedo.MERGE_DISABLE, root)
	_undo_redo.add_do_property(node, property, external_resource)
	_undo_redo.add_do_reference(external_resource)
	_undo_redo.add_undo_property(node, property, resource)
	_undo_redo.commit_action()
	_editor.get_resource_filesystem().update_file(path)
	return {
		"saved": true,
		"nodePath": node_path,
		"property": property,
		"path": path,
		"previousPath": previous_path,
		"class": external_resource.get_class(),
		"bytes": FileAccess.get_file_as_bytes(path).size(),
		"sha256": FileAccess.get_sha256(path),
		"overwritten": existed,
		"undoable": false,
		"referenceUndoable": true,
		"fileUndoable": false,
	}


func _resource_focus(params: Dictionary) -> Dictionary:
	var checked_path := _validated_res_path(str(params.get("path", "")), ["tres", "tscn", "gd", "res"])
	if checked_path.has("_error"):
		return checked_path
	var path: String = checked_path.path
	if not FileAccess.file_exists(path):
		return _failure("EDITOR_RESOURCE_NOT_FOUND", "Resource file was not found.", {"path": path})
	var resource := load(path)
	if not resource is Resource:
		return _failure("EDITOR_RESOURCE_LOAD_FAILED", "Godot could not load the selected Resource.", {"path": path})
	_editor.select_file(path)
	_editor.edit_resource(resource as Resource)
	return {"selected": true, "path": path, "class": (resource as Resource).get_class()}


func _instance_get(params: Dictionary) -> Dictionary:
	var target := _instance_target(params)
	if target.has("_error"):
		return target
	var root: Node = target.root
	var node: Node = target.node
	return {
		"nodePath": target.nodePath,
		"scenePath": node.scene_file_path,
		"editable": root.is_editable_instance(node),
	}


func _instance_set_editable(params: Dictionary) -> Dictionary:
	var target := _instance_target(params)
	if target.has("_error"):
		return target
	var root: Node = target.root
	var node: Node = target.node
	var editable := bool(params.get("editable", true))
	var previous := root.is_editable_instance(node)
	if previous == editable:
		return _failure("EDITOR_INSTANCE_EDITABLE_UNCHANGED", "PackedScene editable state already has the requested value.", {"nodePath": target.nodePath, "editable": editable})
	_undo_redo.create_action("Agent: set %s editable children" % node.name, UndoRedo.MERGE_DISABLE, root)
	_undo_redo.add_do_method(root, "set_editable_instance", node, editable)
	_undo_redo.add_undo_method(root, "set_editable_instance", node, previous)
	_undo_redo.commit_action()
	return {
		"action": "instance_set_editable",
		"nodePath": target.nodePath,
		"scenePath": node.scene_file_path,
		"editable": root.is_editable_instance(node),
		"previousEditable": previous,
		"undoable": true,
	}


func _instance_target(params: Dictionary) -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _failure("EDITOR_SCENE_NOT_OPEN", "No edited scene is open.")
	var node_path := str(params.get("nodePath", ""))
	var node := _node_at_path(node_path)
	if node == null:
		return _failure("EDITOR_NODE_NOT_FOUND", "Node was not found in the edited scene.", {"nodePath": node_path})
	if node == root or node.scene_file_path.is_empty():
		return _failure("EDITOR_PACKED_SCENE_INSTANCE_REQUIRED", "Node must be the root of an instantiated PackedScene.", {"nodePath": node_path})
	return {"root": root, "node": node, "nodePath": node_path}


func _signal_connect(params: Dictionary) -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _failure("EDITOR_SCENE_NOT_OPEN", "No edited scene is open.")
	var source_path := str(params.get("sourcePath", ""))
	var target_path := str(params.get("targetPath", ""))
	var signal_name := str(params.get("signal", ""))
	var method := str(params.get("method", ""))
	var source := _node_at_path(source_path)
	var target := _node_at_path(target_path)
	if source == null or target == null:
		return _failure("EDITOR_SIGNAL_NODE_NOT_FOUND", "Signal source or target node was not found.", {"sourcePath": source_path, "targetPath": target_path})
	if signal_name.is_empty() or not source.has_signal(signal_name):
		return _failure("EDITOR_SIGNAL_NOT_FOUND", "Source does not declare the requested signal.", {"signal": signal_name})
	if method.is_empty() or not target.has_method(method):
		return _failure("EDITOR_SIGNAL_METHOD_NOT_FOUND", "Target method was not found.", {"method": method})
	var callable := Callable(target, method)
	if source.is_connected(signal_name, callable):
		return _failure("EDITOR_SIGNAL_ALREADY_CONNECTED", "This signal connection already exists.", {"signal": signal_name})
	var allowed_flags := CONNECT_DEFERRED | CONNECT_PERSIST | CONNECT_ONE_SHOT | CONNECT_REFERENCE_COUNTED
	var flags := int(params.get("flags", CONNECT_PERSIST)) & allowed_flags
	flags |= CONNECT_PERSIST
	_undo_redo.create_action("Agent: connect %s" % signal_name, UndoRedo.MERGE_DISABLE, root)
	_undo_redo.add_do_method(source, "connect", StringName(signal_name), callable, flags)
	_undo_redo.add_undo_method(source, "disconnect", StringName(signal_name), callable)
	_undo_redo.commit_action()
	return {
		"action": "signal_connect",
		"sourcePath": source_path,
		"signal": signal_name,
		"targetPath": target_path,
		"method": method,
		"flags": flags,
		"undoable": true,
	}


func _scene_save() -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _failure("EDITOR_SCENE_NOT_OPEN", "No edited scene is open.")
	var error := _editor.save_scene()
	if error != OK:
		return _failure("EDITOR_SCENE_SAVE_FAILED", "Godot could not save the edited scene.", {"error": error, "scene": root.scene_file_path})
	return {"saved": true, "scene": root.scene_file_path, "error": error}


func _selection_get() -> Dictionary:
	var root := _editor.get_edited_scene_root()
	var paths: Array[String] = []
	if root != null:
		for selected in _editor.get_selection().get_selected_nodes():
			if selected == root or root.is_ancestor_of(selected):
				paths.append(_logical_path(selected))
	return {"paths": paths, "focusedPath": paths[0] if not paths.is_empty() else null}


func _selection_set(params: Dictionary) -> Dictionary:
	var raw_paths = params.get("paths", [])
	if typeof(raw_paths) != TYPE_ARRAY or raw_paths.size() > 100:
		return _failure("EDITOR_SELECTION_INVALID", "paths must be an array with at most 100 node paths.")
	var nodes: Array[Node] = []
	for path_value in raw_paths:
		var path := str(path_value)
		var node := _node_at_path(path)
		if node == null:
			return _failure("EDITOR_NODE_NOT_FOUND", "A selected node was not found in the edited scene.", {"nodePath": path})
		nodes.append(node)
	var selection := _editor.get_selection()
	selection.clear()
	for node in nodes:
		selection.add_node(node)
	var focus := bool(params.get("focus", true))
	if focus and not nodes.is_empty():
		_editor.edit_node(nodes[0])
	return _selection_get()


func _history_step(action: String) -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _failure("EDITOR_SCENE_NOT_OPEN", "No edited scene is open.")
	var history_id := _undo_redo.get_object_history_id(root)
	var history: UndoRedo = _undo_redo.get_history_undo_redo(history_id)
	if history == null:
		return _failure("EDITOR_HISTORY_NOT_FOUND", "Godot did not expose an Undo/Redo history for the edited scene.")
	var available := history.has_undo() if action == "undo" else history.has_redo()
	if not available:
		return _failure("EDITOR_HISTORY_EMPTY", "The edited scene has no action available to %s." % action, {"action": action})
	var before_version := history.get_version()
	var action_name := history.get_current_action_name() if action == "undo" else ""
	var performed: bool
	if action == "undo":
		performed = history.undo()
	else:
		performed = history.redo()
		action_name = history.get_current_action_name()
	if not performed:
		return _failure("EDITOR_HISTORY_STEP_FAILED", "Godot could not %s the current scene action." % action, {"action": action})
	return {
		"action": action,
		"performed": true,
		"actionName": action_name,
		"beforeVersion": before_version,
		"afterVersion": history.get_version(),
	}


func _node_at_path(path: String) -> Node:
	var root := _editor.get_edited_scene_root()
	if root == null or path.is_empty():
		return null
	var logical_root := "/root/%s" % root.name
	if path in [str(root.get_path()), logical_root, "."]:
		return root
	if path.begins_with(logical_root + "/"):
		return root.get_node_or_null(NodePath(path.trim_prefix(logical_root + "/")))
	if path.begins_with("/root/"):
		return null
	return root.get_node_or_null(NodePath(path))


func _validated_res_path(path: String, allowed_extensions: Array) -> Dictionary:
	if path.is_empty() or not path.begins_with("res://") or path.contains("\\"):
		return _failure("EDITOR_RESOURCE_PATH_INVALID", "Path must be a forward-slash res:// path.", {"path": path})
	var normalized := path.simplify_path()
	if normalized != path or normalized == "res://":
		return _failure("EDITOR_RESOURCE_PATH_INVALID", "Path must be normalized and remain below res://.", {"path": path})
	var extension := path.get_extension().to_lower()
	if not allowed_extensions.is_empty() and extension not in allowed_extensions:
		return _failure("EDITOR_RESOURCE_EXTENSION_INVALID", "Path extension is not allowed for this operation.", {"path": path, "allowedExtensions": allowed_extensions})
	var project_root := ProjectSettings.globalize_path("res://").simplify_path().trim_suffix("/")
	var absolute_path := ProjectSettings.globalize_path(path).simplify_path()
	if absolute_path.to_lower() != project_root.to_lower() and not absolute_path.to_lower().begins_with(project_root.to_lower() + "/"):
		return _failure("EDITOR_RESOURCE_PATH_ESCAPE", "Resolved path escapes the project root.", {"path": path})
	var access := DirAccess.open("res://")
	if access == null:
		return _failure("EDITOR_PROJECT_DIRECTORY_UNAVAILABLE", "Godot could not open the project resource directory.")
	var current := ""
	for segment in path.trim_prefix("res://").split("/", false):
		current = segment if current.is_empty() else current.path_join(segment)
		if access.is_link(current):
			return _failure("EDITOR_RESOURCE_PATH_LINK_REJECTED", "Resource path crosses a symbolic link or junction.", {"path": path, "component": current})
	return {"path": normalized, "absolutePath": absolute_path}


func _describe_node(node: Node, properties: Dictionary) -> Dictionary:
	return {
		"path": _logical_path(node),
		"name": str(node.name),
		"type": node.get_class(),
		"owner": _logical_path(node.owner) if node.owner != null else null,
		"properties": properties,
	}


func _logical_path(node: Node) -> String:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return ""
	var logical_root := "/root/%s" % root.name
	if node == root:
		return logical_root
	var relative := str(root.get_path_to(node))
	return logical_root + "/" + relative


func _validate_node_name(value: String) -> String:
	if value.is_empty():
		return "Node name must not be empty."
	for invalid in [".", ":", "@", "/", "\"", "%"]:
		if value.contains(invalid):
			return "Node name contains a reserved character: %s" % invalid
	return ""


func _property_descriptor(object: Object, property: String) -> Dictionary:
	for descriptor in object.get_property_list():
		if str(descriptor.name) == property:
			return descriptor
	return {}


func _resource_class_from_descriptor(descriptor: Dictionary) -> String:
	if descriptor.is_empty() or int(descriptor.get("type", TYPE_NIL)) != TYPE_OBJECT:
		return ""
	var required_class := str(descriptor.get("class_name", ""))
	if required_class.is_empty() and int(descriptor.get("hint", PROPERTY_HINT_NONE)) == PROPERTY_HINT_RESOURCE_TYPE:
		required_class = str(descriptor.get("hint_string", "")).split(",")[0]
	return required_class


func _prepare_properties(object: Object, raw: Variant) -> Dictionary:
	if typeof(raw) != TYPE_DICTIONARY or raw.size() > 100:
		return _failure("EDITOR_PROPERTIES_INVALID", "properties must be an object with at most 100 entries.")
	var changes: Array[Dictionary] = []
	var names: Array[String] = []
	for key in raw:
		var property := str(key)
		if property in ["name", "owner", "scene_file_path", "resource_path"]:
			return _failure("EDITOR_PROPERTY_RESTRICTED", "Use the dedicated structural operation for this property.", {"property": property})
		var descriptor := _property_descriptor(object, property)
		if descriptor.is_empty():
			return _failure("EDITOR_PROPERTY_NOT_FOUND", "Object property does not exist.", {"property": property, "objectType": object.get_class()})
		if int(descriptor.usage) & PROPERTY_USAGE_READ_ONLY:
			return _failure("EDITOR_PROPERTY_READ_ONLY", "Node property is read-only.", {"property": property})
		var decoded := _decode_value(raw[key], 0, _resource_class_from_descriptor(descriptor))
		if decoded.has("_error"):
			return decoded
		var coerced := _coerce_property_value(decoded.value, int(descriptor.type), property)
		if coerced.has("_error"):
			return coerced
		changes.append({"property": StringName(property), "value": coerced.value, "previous": object.get(property)})
		names.append(property)
	return {"changes": changes, "names": names}


func _coerce_property_value(value: Variant, expected_type: int, property: String) -> Dictionary:
	if value == null:
		return {"value": value}
	var actual_type := typeof(value)
	if actual_type == expected_type:
		return {"value": value}
	if expected_type == TYPE_FLOAT and actual_type == TYPE_INT:
		return {"value": float(value)}
	if expected_type == TYPE_INT and actual_type == TYPE_FLOAT and value == floor(value) and abs(value) <= 9007199254740991.0:
		return {"value": int(value)}
	if expected_type == TYPE_STRING_NAME and actual_type == TYPE_STRING:
		return {"value": StringName(value)}
	if expected_type == TYPE_NODE_PATH and actual_type == TYPE_STRING:
		return {"value": NodePath(value)}
	return _failure(
		"EDITOR_PROPERTY_TYPE_MISMATCH",
		"Property value type does not match Godot's declared type.",
		{"property": property, "expectedType": expected_type, "actualType": actual_type}
	)


func _decode_value(value: Variant, depth: int = 0, expected_resource_class: String = "") -> Dictionary:
	if depth >= 8:
		return _failure("EDITOR_VALUE_TOO_DEEP", "Property value exceeds the maximum nesting depth of 8.")
	if typeof(value) == TYPE_ARRAY:
		if value.size() > 100:
			return _failure("EDITOR_VALUE_TOO_LARGE", "Property array exceeds 100 elements.")
		var decoded_array := []
		for item in value:
			var decoded := _decode_value(item, depth + 1)
			if decoded.has("_error"):
				return decoded
			decoded_array.append(decoded.value)
		return {"value": decoded_array}
	if typeof(value) != TYPE_DICTIONARY:
		return {"value": value}
	if value.size() > 100:
		return _failure("EDITOR_VALUE_TOO_LARGE", "Property object exceeds 100 entries.")
	if value.has("$type"):
		var type_name := str(value.get("$type", ""))
		match type_name:
			"Vector2": return {"value": Vector2(float(value.get("x", 0.0)), float(value.get("y", 0.0)))}
			"Vector2i": return {"value": Vector2i(int(value.get("x", 0)), int(value.get("y", 0)))}
			"Vector3": return {"value": Vector3(float(value.get("x", 0.0)), float(value.get("y", 0.0)), float(value.get("z", 0.0)))}
			"Vector3i": return {"value": Vector3i(int(value.get("x", 0)), int(value.get("y", 0)), int(value.get("z", 0)))}
			"Color": return {"value": Color(float(value.get("r", 0.0)), float(value.get("g", 0.0)), float(value.get("b", 0.0)), float(value.get("a", 1.0)))}
			"Rect2": return {"value": Rect2(float(value.get("x", 0.0)), float(value.get("y", 0.0)), float(value.get("width", 0.0)), float(value.get("height", 0.0)))}
			"Rect2i": return {"value": Rect2i(int(value.get("x", 0)), int(value.get("y", 0)), int(value.get("width", 0)), int(value.get("height", 0)))}
			"Quaternion": return {"value": Quaternion(float(value.get("x", 0.0)), float(value.get("y", 0.0)), float(value.get("z", 0.0)), float(value.get("w", 1.0)))}
			"Plane": return {"value": Plane(float(value.get("x", 0.0)), float(value.get("y", 0.0)), float(value.get("z", 0.0)), float(value.get("d", 0.0)))}
			"Transform2D": return _decode_transform2d(value, depth)
			"Basis": return _decode_basis(value, depth)
			"Transform3D": return _decode_transform3d(value, depth)
			"AABB": return _decode_aabb(value, depth)
			"NodePath": return {"value": NodePath(str(value.get("path", "")))}
			"StringName": return {"value": StringName(str(value.get("value", "")))}
			"Resource":
				var path := str(value.get("path", ""))
				var checked_path := _validated_res_path(path, [])
				if checked_path.has("_error"):
					return checked_path
				var resource = load(str(checked_path.path))
				if not resource is Resource:
					return _failure("EDITOR_RESOURCE_LOAD_FAILED", "Godot could not load the requested resource.", {"path": path})
				if not expected_resource_class.is_empty() and not (resource as Resource).is_class(expected_resource_class):
					return _failure("EDITOR_RESOURCE_CLASS_MISMATCH", "Loaded Resource type is incompatible with the target property.", {"path": path, "class": (resource as Resource).get_class(), "requiredClass": expected_resource_class})
				return {"value": resource}
			_:
				return _failure("EDITOR_VALUE_TYPE_UNKNOWN", "Unknown tagged Godot value type.", {"type": type_name})
	var decoded_dictionary := {}
	for key in value:
		var decoded := _decode_value(value[key], depth + 1)
		if decoded.has("_error"):
			return decoded
		decoded_dictionary[str(key)] = decoded.value
	return {"value": decoded_dictionary}


func _decode_typed_field(container: Dictionary, field: String, expected_type: int, depth: int) -> Dictionary:
	if not container.has(field):
		return _failure("EDITOR_VALUE_FIELD_MISSING", "Tagged Godot value is missing a required field.", {"field": field})
	var decoded := _decode_value(container[field], depth + 1)
	if decoded.has("_error"):
		return decoded
	if typeof(decoded.value) != expected_type:
		return _failure("EDITOR_VALUE_FIELD_TYPE_MISMATCH", "Tagged Godot value field has the wrong type.", {"field": field, "expectedType": expected_type, "actualType": typeof(decoded.value)})
	return decoded


func _decode_transform2d(value: Dictionary, depth: int) -> Dictionary:
	var x_axis := _decode_typed_field(value, "xAxis", TYPE_VECTOR2, depth)
	if x_axis.has("_error"): return x_axis
	var y_axis := _decode_typed_field(value, "yAxis", TYPE_VECTOR2, depth)
	if y_axis.has("_error"): return y_axis
	var origin := _decode_typed_field(value, "origin", TYPE_VECTOR2, depth)
	if origin.has("_error"): return origin
	return {"value": Transform2D(x_axis.value, y_axis.value, origin.value)}


func _decode_basis(value: Dictionary, depth: int) -> Dictionary:
	var x_axis := _decode_typed_field(value, "xAxis", TYPE_VECTOR3, depth)
	if x_axis.has("_error"): return x_axis
	var y_axis := _decode_typed_field(value, "yAxis", TYPE_VECTOR3, depth)
	if y_axis.has("_error"): return y_axis
	var z_axis := _decode_typed_field(value, "zAxis", TYPE_VECTOR3, depth)
	if z_axis.has("_error"): return z_axis
	return {"value": Basis(x_axis.value, y_axis.value, z_axis.value)}


func _decode_transform3d(value: Dictionary, depth: int) -> Dictionary:
	var basis := _decode_typed_field(value, "basis", TYPE_BASIS, depth)
	if basis.has("_error"): return basis
	var origin := _decode_typed_field(value, "origin", TYPE_VECTOR3, depth)
	if origin.has("_error"): return origin
	return {"value": Transform3D(basis.value, origin.value)}


func _decode_aabb(value: Dictionary, depth: int) -> Dictionary:
	var position := _decode_typed_field(value, "position", TYPE_VECTOR3, depth)
	if position.has("_error"): return position
	var size := _decode_typed_field(value, "size", TYPE_VECTOR3, depth)
	if size.has("_error"): return size
	return {"value": AABB(position.value, size.value)}


func _encode_value(value: Variant, depth: int = 0) -> Variant:
	if depth >= 8:
		return {"$truncated": "max-depth"}
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT:
			return value
		TYPE_STRING:
			return str(value).left(4096)
		TYPE_STRING_NAME:
			return {"$type": "StringName", "value": str(value)}
		TYPE_NODE_PATH:
			return {"$type": "NodePath", "path": str(value)}
		TYPE_VECTOR2:
			return {"$type": "Vector2", "x": value.x, "y": value.y}
		TYPE_VECTOR2I:
			return {"$type": "Vector2i", "x": value.x, "y": value.y}
		TYPE_VECTOR3:
			return {"$type": "Vector3", "x": value.x, "y": value.y, "z": value.z}
		TYPE_VECTOR3I:
			return {"$type": "Vector3i", "x": value.x, "y": value.y, "z": value.z}
		TYPE_COLOR:
			return {"$type": "Color", "r": value.r, "g": value.g, "b": value.b, "a": value.a}
		TYPE_RECT2:
			return {"$type": "Rect2", "x": value.position.x, "y": value.position.y, "width": value.size.x, "height": value.size.y}
		TYPE_RECT2I:
			return {"$type": "Rect2i", "x": value.position.x, "y": value.position.y, "width": value.size.x, "height": value.size.y}
		TYPE_QUATERNION:
			return {"$type": "Quaternion", "x": value.x, "y": value.y, "z": value.z, "w": value.w}
		TYPE_PLANE:
			return {"$type": "Plane", "x": value.normal.x, "y": value.normal.y, "z": value.normal.z, "d": value.d}
		TYPE_TRANSFORM2D:
			return {"$type": "Transform2D", "xAxis": _encode_value(value.x, depth + 1), "yAxis": _encode_value(value.y, depth + 1), "origin": _encode_value(value.origin, depth + 1)}
		TYPE_BASIS:
			return {"$type": "Basis", "xAxis": _encode_value(value.x, depth + 1), "yAxis": _encode_value(value.y, depth + 1), "zAxis": _encode_value(value.z, depth + 1)}
		TYPE_TRANSFORM3D:
			return {"$type": "Transform3D", "basis": _encode_value(value.basis, depth + 1), "origin": _encode_value(value.origin, depth + 1)}
		TYPE_AABB:
			return {"$type": "AABB", "position": _encode_value(value.position, depth + 1), "size": _encode_value(value.size, depth + 1)}
		TYPE_ARRAY:
			var result := []
			for index in range(mini(value.size(), 100)):
				result.append(_encode_value(value[index], depth + 1))
			return result
		TYPE_DICTIONARY:
			var result := {}
			var keys: Array = value.keys()
			for index in range(mini(keys.size(), 100)):
				var key = keys[index]
				result[str(key)] = _encode_value(value[key], depth + 1)
			return result
		TYPE_OBJECT:
			if value is Resource:
				var resource := value as Resource
				return {"$type": "Resource", "path": resource.resource_path, "class": resource.get_class()}
			if value is Node:
				return {"$type": "NodePath", "path": _logical_path(value as Node)}
	return str(value).left(4096)


func _encoded_properties(object: Object, names: Array) -> Dictionary:
	var result := {}
	for property in names:
		result[str(property)] = _encode_value(object.get(str(property)))
	return result


func _failure(code: String, message: String, details: Dictionary = {}) -> Dictionary:
	return {"_error": {"code": code, "message": message, "details": details}}


func _screenshot(params: Dictionary) -> Dictionary:
	var viewport_kind := str(params.get("viewport", "2d"))
	if viewport_kind not in ["2d", "3d"]:
		return _failure("EDITOR_SCREENSHOT_VIEWPORT_INVALID", "viewport must be 2d or 3d.", {"viewport": viewport_kind})
	var viewport_index := int(params.get("viewportIndex", 0))
	if viewport_index < 0 or viewport_index > 3:
		return _failure("EDITOR_SCREENSHOT_VIEWPORT_INDEX_INVALID", "viewportIndex must be between 0 and 3.", {"viewportIndex": viewport_index})
	_editor.set_main_screen_editor("3D" if viewport_kind == "3d" else "2D")
	for _frame in range(3):
		await get_tree().process_frame
	RenderingServer.force_draw(false, 0.0)
	var viewport := _editor.get_editor_viewport_3d(viewport_index) if viewport_kind == "3d" else _editor.get_editor_viewport_2d()
	if viewport == null:
		return _failure("EDITOR_SCREENSHOT_VIEWPORT_UNAVAILABLE", "The requested editor viewport is unavailable.", {"viewport": viewport_kind, "viewportIndex": viewport_index})
	var image := viewport.get_texture().get_image()
	if image == null or image.is_empty():
		return _failure("EDITOR_SCREENSHOT_EMPTY", "The requested editor viewport did not produce an image.", {"viewport": viewport_kind, "viewportIndex": viewport_index})
	var directory := ProjectSettings.globalize_path("res://.godot/agent-runtime/evidence/%s" % _run_id)
	var mkdir_error := DirAccess.make_dir_recursive_absolute(directory)
	if mkdir_error != OK:
		return {"_error": {"code": "EDITOR_SCREENSHOT_DIRECTORY_FAILED", "message": "Could not create evidence directory."}}
	var suffix := "%s-%d" % [viewport_kind, viewport_index] if viewport_kind == "3d" else "2d"
	var path := directory.path_join("editor-%s-%d.png" % [suffix, Time.get_ticks_msec()])
	var error := image.save_png(path)
	if error != OK:
		return {"_error": {"code": "EDITOR_SCREENSHOT_SAVE_FAILED", "message": "Could not save editor screenshot."}}
	var camera_data = null
	if viewport_kind == "3d":
		var camera := viewport.get_camera_3d()
		if camera == null:
			return _failure("EDITOR_SCREENSHOT_CAMERA_UNAVAILABLE", "The requested 3D editor viewport has no active camera.", {"viewportIndex": viewport_index})
		var projection_name := "perspective"
		match camera.projection:
			Camera3D.PROJECTION_ORTHOGONAL:
				projection_name = "orthogonal"
			Camera3D.PROJECTION_FRUSTUM:
				projection_name = "frustum"
		camera_data = {
			"projection": projection_name,
			"position": _plain_vector3(camera.global_position),
			"rotationDegrees": _plain_vector3(camera.global_rotation_degrees),
			"fov": camera.fov,
			"size": camera.size,
			"near": camera.near,
			"far": camera.far,
		}
	return {
		"path": path.replace("\\", "/"),
		"width": image.get_width(),
		"height": image.get_height(),
		"viewport": viewport_kind,
		"viewportIndex": viewport_index if viewport_kind == "3d" else null,
		"camera": camera_data,
	}


func _plain_vector3(value: Vector3) -> Dictionary:
	return {"x": value.x, "y": value.y, "z": value.z}


func _send_ok(peer: Dictionary, request_id: String, result: Dictionary) -> void:
	if result.has("_error"):
		_send(peer, {"id": request_id, "ok": false, "error": result._error})
	else:
		_send(peer, {"id": request_id, "ok": true, "result": result})


func _send(peer: Dictionary, response: Dictionary) -> void:
	var bytes := (JSON.stringify(response) + "\n").to_utf8_buffer()
	if bytes.size() > MAX_MESSAGE_BYTES:
		var request_id := str(response.get("id", ""))
		bytes = (JSON.stringify({
			"id": request_id,
			"ok": false,
			"error": {
				"code": "EDITOR_RESPONSE_TOO_LARGE",
				"message": "Editor bridge response exceeded 1 MiB.",
				"details": {"bytes": bytes.size(), "maxBytes": MAX_MESSAGE_BYTES},
			},
		}) + "\n").to_utf8_buffer()
	(peer.stream as StreamPeerTCP).put_data(bytes)


func _exit_tree() -> void:
	for peer in _peers:
		(peer.stream as StreamPeerTCP).disconnect_from_host()
	_peers.clear()
	if _server != null:
		_server.stop()
