@tool
extends Node

const PROTOCOL_VERSION := "0.6.0"
const MAX_MESSAGE_BYTES := 1024 * 1024
const MAX_PROJECT_SETTING_OPERATIONS := 128

var _editor: EditorInterface
var _undo_redo: EditorUndoRedoManager
var _server: TCPServer
var _port := 0
var _token := ""
var _run_id := ""
var _peers: Array[Dictionary] = []
var _batch_dirty_versions := {}
var _loaded_project_file_sha256 := ""
var _project_setting_operations := {}
var _project_setting_operation_order: Array[String] = []


func configure(editor: EditorInterface, undo_redo: EditorUndoRedoManager) -> void:
	_editor = editor
	_undo_redo = undo_redo


func _ready() -> void:
	_port = int(OS.get_environment("GODOT_AGENT_RUNTIME_PORT"))
	_token = OS.get_environment("GODOT_AGENT_RUNTIME_TOKEN")
	_run_id = OS.get_environment("GODOT_AGENT_RUNTIME_RUN_ID")
	_loaded_project_file_sha256 = FileAccess.get_sha256("res://project.godot")
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
				"historyVersion": _history_version(root) if root != null else null,
				"capabilities": ["scene_tree", "selection", "screenshot", "viewport_3d", "node_edit", "scene_instantiate", "scene_inheritance", "instance_editable", "resource_edit", "resource_save", "resource_focus", "signal_connect", "scene_save", "scene_open", "scene_batch", "undo_redo", "project_settings", "input_map", "resource_inspect"],
			})
		"project_setting_get":
			_send_ok(peer, request_id, _project_setting_get(params))
		"project_setting_set":
			_send_ok(peer, request_id, await _project_setting_set(params))
		"project_setting_operation_status":
			_send_ok(peer, request_id, _project_setting_operation_status(params))
		"input_action_upsert":
			_send_ok(peer, request_id, await _input_action_upsert(params))
		"resource_inspect":
			_send_ok(peer, request_id, _resource_inspect(params))
		"scene_open":
			_send_ok(peer, request_id, await _scene_open(params))
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
		"scene_batch":
			_send_ok(peer, request_id, _scene_batch(params))
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
			_send_ok(peer, request_id, _scene_save(params))
		"history_undo":
			_send_ok(peer, request_id, _history_step("undo", params))
		"history_redo":
			_send_ok(peer, request_id, _history_step("redo", params))
		_:
			_send(peer, {"id": request_id, "ok": false, "error": {"code": "EDITOR_COMMAND_UNKNOWN", "message": "Unknown editor command."}})


func _history_for_root(root: Node) -> UndoRedo:
	var history_id := _undo_redo.get_object_history_id(root)
	return _undo_redo.get_history_undo_redo(history_id)


func _project_setting_key_allowed(key: String) -> bool:
	if key in ["application/run/main_scene"]:
		return true
	for prefix in [
		"application/config/",
		"display/window/",
		"rendering/",
		"physics/2d/",
		"physics/3d/",
	]:
		if key.begins_with(prefix):
			return true
	return false


func _project_setting_value_supported(value: Variant) -> bool:
	if typeof(value) in [TYPE_BOOL, TYPE_INT, TYPE_FLOAT]:
		return true
	if typeof(value) == TYPE_STRING:
		return str(value).to_utf8_buffer().size() <= 16 * 1024
	if typeof(value) in [TYPE_ARRAY, TYPE_PACKED_STRING_ARRAY]:
		if value.size() > 256:
			return false
		for item in value:
			if typeof(item) != TYPE_STRING or str(item).to_utf8_buffer().size() > 16 * 1024:
				return false
		return true
	return false


func _encode_project_setting_value(value: Variant) -> Variant:
	if typeof(value) == TYPE_PACKED_STRING_ARRAY:
		return Array(value)
	return value


func _coerce_project_setting_value(key: String, value: Variant, previous: Variant) -> Dictionary:
	if not _project_setting_value_supported(value):
		return _failure("EDITOR_PROJECT_SETTING_VALUE_UNSUPPORTED", "Project setting value must be a bounded bool, int, float, string, or string array.", {"key": key, "actualType": typeof(value)})
	var expected_type := typeof(previous)
	var actual_type := typeof(value)
	if expected_type == TYPE_INT and actual_type in [TYPE_INT, TYPE_FLOAT] and float(value) == floor(float(value)) and abs(float(value)) <= 9007199254740991.0:
		return {"value": int(value)}
	if expected_type == TYPE_FLOAT and actual_type in [TYPE_INT, TYPE_FLOAT]:
		return {"value": float(value)}
	if expected_type == TYPE_PACKED_STRING_ARRAY and actual_type == TYPE_ARRAY:
		for item in value:
			if typeof(item) != TYPE_STRING:
				return _failure("EDITOR_PROJECT_SETTING_TYPE_MISMATCH", "Project setting string arrays may contain only strings.", {"key": key})
		return {"value": PackedStringArray(value)}
	if expected_type != actual_type:
		return _failure("EDITOR_PROJECT_SETTING_TYPE_MISMATCH", "Project setting value type does not match the existing Godot Variant type.", {
			"key": key,
			"expectedType": expected_type,
			"actualType": actual_type,
		})
	return {"value": value}


func _validate_project_setting_key(key: String) -> Dictionary:
	if not _project_setting_key_allowed(key):
		return _failure("EDITOR_PROJECT_SETTING_RESTRICTED", "Project setting key is outside the structured allowlist.", {"key": key})
	if not ProjectSettings.has_setting(key):
		return _failure("EDITOR_PROJECT_SETTING_NOT_FOUND", "Only existing project settings may be changed.", {"key": key})
	return {"key": key}


func _project_setting_get(params: Dictionary) -> Dictionary:
	var key := str(params.get("key", ""))
	var allowed := _validate_project_setting_key(key)
	if allowed.has("_error"):
		return allowed
	var value = ProjectSettings.get_setting(key)
	if not _project_setting_value_supported(value):
		return _failure("EDITOR_PROJECT_SETTING_VALUE_UNSUPPORTED", "Existing project setting type is not supported by this bounded tool.", {"key": key, "actualType": typeof(value)})
	return {"key": key, "value": _encode_project_setting_value(value)}


func _remember_project_setting_operation(operation_id: String, receipt: Dictionary) -> void:
	if not _project_setting_operations.has(operation_id):
		_project_setting_operation_order.append(operation_id)
	_project_setting_operations[operation_id] = receipt
	while _project_setting_operation_order.size() > MAX_PROJECT_SETTING_OPERATIONS:
		var expired := _project_setting_operation_order.pop_front()
		_project_setting_operations.erase(expired)


func _begin_project_setting_operation(params: Dictionary) -> Dictionary:
	var operation_id := str(params.get("operationId", ""))
	if operation_id.is_empty() or operation_id.length() > 64:
		return _failure("EDITOR_PROJECT_SETTING_OPERATION_ID_INVALID", "operationId is required and must be bounded.")
	if _project_setting_operations.has(operation_id):
		var existing: Dictionary = _project_setting_operations[operation_id]
		if str(existing.state) == "succeeded":
			return {"operationId": operation_id, "replayed": true, "result": existing.result}
		if str(existing.state) == "failed":
			return {"operationId": operation_id, "replayed": true, "failure": existing.error}
		return _failure("EDITOR_PROJECT_SETTING_OPERATION_RUNNING", "The project-setting operation is already running.", {"operationId": operation_id})
	_remember_project_setting_operation(operation_id, {
		"state": "running",
		"result": null,
		"error": null,
	})
	return {"operationId": operation_id, "replayed": false}


func _finish_project_setting_operation(operation_id: String, result: Dictionary) -> Dictionary:
	if result.has("_error"):
		_remember_project_setting_operation(operation_id, {
			"state": "failed",
			"result": null,
			"error": result._error,
		})
		return result
	_remember_project_setting_operation(operation_id, {
		"state": "succeeded",
		"result": result,
		"error": null,
	})
	return result


func _project_setting_operation_status(params: Dictionary) -> Dictionary:
	var operation_id := str(params.get("operationId", ""))
	if not _project_setting_operations.has(operation_id):
		return {"operationId": operation_id, "state": "unknown", "result": null, "error": null}
	var receipt: Dictionary = _project_setting_operations[operation_id]
	return {
		"operationId": operation_id,
		"state": receipt.state,
		"result": receipt.result,
		"error": receipt.error,
	}


func _project_file_write_guard(params: Dictionary) -> Dictionary:
	var expected_sha := str(params.get("expectedProjectFileSha256", ""))
	if expected_sha.length() != 64:
		return _failure("PROJECT_FILE_SHA256_REQUIRED", "expectedProjectFileSha256 is required for project setting mutations.")
	var disk_sha := FileAccess.get_sha256("res://project.godot")
	if expected_sha != disk_sha:
		return _failure("PROJECT_FILE_CONFLICT", "project.godot changed after the caller obtained its SHA-256 guard.", {
			"expectedSha256": expected_sha,
			"actualSha256": disk_sha,
		})
	if disk_sha != _loaded_project_file_sha256:
		return _failure("EDITOR_PROJECT_SETTINGS_STALE", "The managed editor ProjectSettings cache is stale relative to project.godot.", {
			"loadedProjectFileSha256": _loaded_project_file_sha256,
			"actualSha256": disk_sha,
		})
	return {"beforeSha256": disk_sha}


func _save_project_setting(operation_id: String, before_sha: String, rollback_key: String, rollback_value: Variant) -> Dictionary:
	var delay_ms := int(OS.get_environment("GODOT_AGENT_RUNTIME_TEST_PROJECT_SETTING_DELAY_MS"))
	if delay_ms > 0 and delay_ms <= 30000:
		await get_tree().create_timer(float(delay_ms) / 1000.0).timeout
	var save_error := ProjectSettings.save()
	if save_error != OK:
		ProjectSettings.set_setting(rollback_key, rollback_value)
		return _failure("EDITOR_PROJECT_SETTING_SAVE_FAILED", "Godot could not save project.godot.", {
			"operationId": operation_id,
			"error": save_error,
		})
	var after_sha := FileAccess.get_sha256("res://project.godot")
	if after_sha.is_empty():
		return _failure("EDITOR_PROJECT_SETTING_SAVE_FAILED", "Godot saved project.godot but its resulting SHA-256 could not be read.", {"operationId": operation_id})
	_loaded_project_file_sha256 = after_sha
	return {"beforeSha256": before_sha, "afterSha256": after_sha}


func _project_setting_set(params: Dictionary) -> Dictionary:
	var operation := _begin_project_setting_operation(params)
	if operation.has("_error"):
		return operation
	if bool(operation.get("replayed", false)):
		if operation.has("failure"):
			return {"_error": operation.failure}
		return operation.result
	var operation_id := str(operation.operationId)
	var key := str(params.get("key", ""))
	var allowed := _validate_project_setting_key(key)
	if allowed.has("_error"):
		return _finish_project_setting_operation(operation_id, allowed)
	var guard := _project_file_write_guard(params)
	if guard.has("_error"):
		return _finish_project_setting_operation(operation_id, guard)
	var previous = ProjectSettings.get_setting(key)
	var coerced := _coerce_project_setting_value(key, params.get("value"), previous)
	if coerced.has("_error"):
		return _finish_project_setting_operation(operation_id, coerced)
	if key == "application/run/main_scene":
		var checked_scene := _validated_res_path(str(coerced.value), ["tscn"])
		if checked_scene.has("_error"):
			return _finish_project_setting_operation(operation_id, checked_scene)
		if not FileAccess.file_exists(str(checked_scene.path)):
			return _finish_project_setting_operation(operation_id, _failure("EDITOR_PROJECT_MAIN_SCENE_NOT_FOUND", "The configured main scene does not exist.", {"path": checked_scene.path}))
	var changed: bool = previous != coerced.value
	if not changed:
		return _finish_project_setting_operation(operation_id, {
			"operationId": operation_id,
			"key": key,
			"changed": false,
			"previousValue": _encode_project_setting_value(previous),
			"value": _encode_project_setting_value(coerced.value),
			"beforeSha256": guard.beforeSha256,
			"afterSha256": guard.beforeSha256,
			"undoable": false,
		})
	ProjectSettings.set_setting(key, coerced.value)
	var saved := await _save_project_setting(operation_id, str(guard.beforeSha256), key, previous)
	if saved.has("_error"):
		return _finish_project_setting_operation(operation_id, saved)
	return _finish_project_setting_operation(operation_id, {
		"operationId": operation_id,
		"key": key,
		"changed": true,
		"previousValue": _encode_project_setting_value(previous),
		"value": _encode_project_setting_value(coerced.value),
		"beforeSha256": saved.beforeSha256,
		"afterSha256": saved.afterSha256,
		"undoable": false,
	})


func _input_binding_keys_valid(binding: Dictionary, allowed: Array[String]) -> bool:
	for key in binding.keys():
		if str(key) not in allowed:
			return false
	return true


func _decode_input_binding(raw: Variant) -> Dictionary:
	if typeof(raw) != TYPE_DICTIONARY:
		return _failure("EDITOR_INPUT_EVENT_INVALID", "Each InputMap event must be an object.")
	var binding: Dictionary = raw
	var kind := str(binding.get("type", ""))
	match kind:
		"key":
			if not _input_binding_keys_valid(binding, ["type", "keycode", "physicalKeycode", "shift", "alt", "ctrl", "meta"]):
				return _failure("EDITOR_INPUT_EVENT_INVALID", "Key event contains an unknown field.")
			var has_keycode := binding.has("keycode")
			var has_physical := binding.has("physicalKeycode")
			if has_keycode == has_physical:
				return _failure("EDITOR_INPUT_EVENT_INVALID", "Key event requires exactly one keycode field.")
			var code := int(binding.get("keycode", binding.get("physicalKeycode", 0)))
			if code <= 0:
				return _failure("EDITOR_INPUT_EVENT_INVALID", "Key code must be positive.")
			var event := InputEventKey.new()
			if has_keycode:
				event.keycode = code
			else:
				event.physical_keycode = code
			event.shift_pressed = bool(binding.get("shift", false))
			event.alt_pressed = bool(binding.get("alt", false))
			event.ctrl_pressed = bool(binding.get("ctrl", false))
			event.meta_pressed = bool(binding.get("meta", false))
			return {"event": event}
		"mouse_button":
			if not _input_binding_keys_valid(binding, ["type", "buttonIndex"]):
				return _failure("EDITOR_INPUT_EVENT_INVALID", "Mouse button event contains an unknown field.")
			var button := int(binding.get("buttonIndex", 0))
			if button < 1 or button > 9:
				return _failure("EDITOR_INPUT_EVENT_INVALID", "Mouse button index is outside Godot's bounded range.")
			var event := InputEventMouseButton.new()
			event.button_index = button
			return {"event": event}
		"joypad_button":
			if not _input_binding_keys_valid(binding, ["type", "buttonIndex", "device"]):
				return _failure("EDITOR_INPUT_EVENT_INVALID", "Joypad button event contains an unknown field.")
			var button := int(binding.get("buttonIndex", -1))
			var device := int(binding.get("device", -1))
			if button < 0 or button > 127 or device < -1 or device > 15:
				return _failure("EDITOR_INPUT_EVENT_INVALID", "Joypad binding is outside Godot's bounded range.")
			var event := InputEventJoypadButton.new()
			event.button_index = button
			event.device = device
			return {"event": event}
	return _failure("EDITOR_INPUT_EVENT_INVALID", "InputMap event type is not supported.", {"type": kind})


func _encode_input_binding(event: InputEvent) -> Dictionary:
	if event is InputEventKey:
		var key_event := event as InputEventKey
		var result := {
			"type": "key",
			"shift": key_event.shift_pressed,
			"alt": key_event.alt_pressed,
			"ctrl": key_event.ctrl_pressed,
			"meta": key_event.meta_pressed,
		}
		if key_event.keycode > 0:
			result.keycode = key_event.keycode
		else:
			result.physicalKeycode = key_event.physical_keycode
		return result
	if event is InputEventMouseButton:
		return {"type": "mouse_button", "buttonIndex": (event as InputEventMouseButton).button_index}
	if event is InputEventJoypadButton:
		var joypad_event := event as InputEventJoypadButton
		return {"type": "joypad_button", "buttonIndex": joypad_event.button_index, "device": joypad_event.device}
	return {}


func _input_action_upsert(params: Dictionary) -> Dictionary:
	var operation := _begin_project_setting_operation(params)
	if operation.has("_error"):
		return operation
	if bool(operation.get("replayed", false)):
		if operation.has("failure"):
			return {"_error": operation.failure}
		return operation.result
	var operation_id := str(operation.operationId)
	var name := str(params.get("name", ""))
	var pattern := RegEx.create_from_string("^[A-Za-z0-9_.-]{1,64}$")
	if pattern.search(name) == null:
		return _finish_project_setting_operation(operation_id, _failure("EDITOR_INPUT_ACTION_NAME_INVALID", "Input action name is invalid.", {"name": name}))
	var deadzone := float(params.get("deadzone", -1.0))
	if deadzone < 0.0 or deadzone > 1.0:
		return _finish_project_setting_operation(operation_id, _failure("EDITOR_INPUT_ACTION_DEADZONE_INVALID", "Input action deadzone must be between 0 and 1."))
	var raw_events = params.get("events", null)
	if typeof(raw_events) != TYPE_ARRAY or raw_events.size() < 1 or raw_events.size() > 32:
		return _finish_project_setting_operation(operation_id, _failure("EDITOR_INPUT_EVENTS_INVALID", "Input action requires between 1 and 32 events."))
	var events: Array = []
	for raw_event in raw_events:
		var decoded := _decode_input_binding(raw_event)
		if decoded.has("_error"):
			return _finish_project_setting_operation(operation_id, decoded)
		events.append(decoded.event)
	var guard := _project_file_write_guard(params)
	if guard.has("_error"):
		return _finish_project_setting_operation(operation_id, guard)
	var setting_key := "input/%s" % name
	var had_previous := ProjectSettings.has_setting(setting_key)
	var previous = ProjectSettings.get_setting(setting_key, null)
	if not bool(params.get("replaceEvents", true)) and had_previous and typeof(previous) == TYPE_DICTIONARY:
		var previous_events = previous.get("events", [])
		if typeof(previous_events) == TYPE_ARRAY:
			for previous_event in previous_events:
				if not previous_event is InputEvent or _encode_input_binding(previous_event).is_empty():
					return _finish_project_setting_operation(operation_id, _failure("EDITOR_INPUT_EVENT_UNSUPPORTED", "Existing InputMap action contains an event outside the typed union; replace its events explicitly."))
			events = Array(previous_events) + events
			if events.size() > 32:
				return _finish_project_setting_operation(operation_id, _failure("EDITOR_INPUT_EVENTS_INVALID", "Merged InputMap events exceed the maximum of 32."))
	var encoded_events: Array[Dictionary] = []
	for event in events:
		var encoded := _encode_input_binding(event)
		if not encoded.is_empty():
			encoded_events.append(encoded)
	var unchanged: bool = had_previous and typeof(previous) == TYPE_DICTIONARY and previous.get("deadzone", -1.0) == deadzone
	if unchanged:
		var stored_events = previous.get("events", null)
		unchanged = typeof(stored_events) == TYPE_ARRAY and stored_events.size() == encoded_events.size()
		if unchanged:
			for index in range(stored_events.size()):
				var stored_event = stored_events[index]
				if not stored_event is InputEvent or _encode_input_binding(stored_event) != encoded_events[index]:
					unchanged = false
					break
	if unchanged:
		return _finish_project_setting_operation(operation_id, {
			"operationId": operation_id,
			"name": name,
			"deadzone": deadzone,
			"replaceEvents": bool(params.get("replaceEvents", true)),
			"events": encoded_events,
			"changed": false,
			"beforeSha256": guard.beforeSha256,
			"afterSha256": guard.beforeSha256,
			"undoable": false,
		})
	ProjectSettings.set_setting(setting_key, {"deadzone": deadzone, "events": events})
	var saved := await _save_project_setting(operation_id, str(guard.beforeSha256), setting_key, previous)
	if saved.has("_error"):
		if not had_previous:
			ProjectSettings.set_setting(setting_key, null)
		return _finish_project_setting_operation(operation_id, saved)
	InputMap.load_from_project_settings()
	return _finish_project_setting_operation(operation_id, {
		"operationId": operation_id,
		"name": name,
		"deadzone": deadzone,
		"replaceEvents": bool(params.get("replaceEvents", true)),
		"events": encoded_events,
		"changed": true,
		"beforeSha256": saved.beforeSha256,
		"afterSha256": saved.afterSha256,
		"undoable": false,
	})


func _resource_inspect(params: Dictionary) -> Dictionary:
	var checked := _validated_res_path(str(params.get("path", "")), ["tres", "res"])
	if checked.has("_error"):
		return checked
	var path := str(checked.path)
	if not FileAccess.file_exists(path):
		return _failure("EDITOR_RESOURCE_NOT_FOUND", "Resource file was not found.", {"path": path})
	var loaded = ResourceLoader.load(path)
	if not loaded is Resource:
		return _failure("EDITOR_RESOURCE_LOAD_FAILED", "Godot could not load the requested Resource.", {"path": path})
	var resource := loaded as Resource
	var editable: Array[String] = []
	var descriptors := {}
	for descriptor in resource.get_property_list():
		var property := str(descriptor.get("name", ""))
		var usage := int(descriptor.get("usage", 0))
		if not property.is_empty():
			descriptors[property] = descriptor
		if not property.is_empty() and (usage & PROPERTY_USAGE_EDITOR) != 0 and (usage & PROPERTY_USAGE_READ_ONLY) == 0:
			if editable.size() < 1000:
				editable.append(property)
	var values := {}
	if params.has("properties"):
		var requested = params.properties
		if typeof(requested) != TYPE_ARRAY or requested.size() > 100:
			return _failure("EDITOR_PROPERTIES_INVALID", "properties must contain at most 100 names.")
		for item in requested:
			var property := str(item)
			if not descriptors.has(property):
				return _failure("EDITOR_PROPERTY_NOT_FOUND", "Resource property does not exist.", {"path": path, "property": property})
			values[property] = _encode_value(resource.get(property))
	return {
		"resource": {
			"path": path,
			"class": resource.get_class(),
			"editableProperties": editable,
			"properties": values,
		},
	}


func _history_version(root: Node) -> Variant:
	var history := _history_for_root(root)
	return history.get_version() if history != null else null


func _require_edited_scene(params: Dictionary) -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _failure("EDITOR_SCENE_NOT_OPEN", "No edited scene is open.")
	var expected := str(params.get("expectedScenePath", ""))
	if expected.is_empty():
		return _failure("EDITOR_SCENE_PATH_REQUIRED", "expectedScenePath is required for scene mutations.")
	if root.scene_file_path != expected:
		return _failure("EDITOR_SCENE_MISMATCH", "The active scene does not match expectedScenePath.", {
			"expectedScenePath": expected,
			"actualScenePath": root.scene_file_path,
		})
	return {"ok": true, "root": root}


func _require_history_version(params: Dictionary, root: Node) -> Dictionary:
	if not params.has("expectedHistoryVersion"):
		return _failure("EDITOR_HISTORY_VERSION_REQUIRED", "expectedHistoryVersion is required for scene save, undo, and redo.")
	var raw_expected = params.expectedHistoryVersion
	if typeof(raw_expected) not in [TYPE_INT, TYPE_FLOAT] or float(raw_expected) < 0.0 or float(raw_expected) != floor(float(raw_expected)):
		return _failure("EDITOR_HISTORY_VERSION_INVALID", "expectedHistoryVersion must be a non-negative integer.", {"expectedHistoryVersion": raw_expected})
	var history := _history_for_root(root)
	if history == null:
		return _failure("EDITOR_HISTORY_NOT_FOUND", "Godot did not expose an Undo/Redo history for the edited scene.")
	var expected := int(raw_expected)
	var actual := history.get_version()
	if expected != actual:
		return _failure("EDITOR_HISTORY_CONFLICT", "The edited scene history changed after the caller obtained its guard.", {
			"expectedHistoryVersion": expected,
			"actualHistoryVersion": actual,
		})
	return {"ok": true, "history": history}


func _scene_open(params: Dictionary) -> Dictionary:
	if str(params.get("expectedProjectFingerprint", "")).is_empty():
		return _failure("PROJECT_FINGERPRINT_REQUIRED", "expectedProjectFingerprint is required before opening an editor scene.")
	var checked_path := _validated_res_path(str(params.get("scenePath", "")), ["tscn"])
	if checked_path.has("_error"):
		return checked_path
	var scene_path: String = checked_path.path
	if not FileAccess.file_exists(scene_path):
		return _failure("EDITOR_SCENE_RESOURCE_NOT_FOUND", "PackedScene file was not found.", {"scenePath": scene_path})
	var previous_root := _editor.get_edited_scene_root()
	var previous_scene = previous_root.scene_file_path if previous_root != null and not previous_root.scene_file_path.is_empty() else null
	_editor.open_scene_from_path(scene_path)
	for _frame in range(120):
		await get_tree().process_frame
		var opened_root := _editor.get_edited_scene_root()
		if opened_root != null and opened_root.scene_file_path == scene_path:
			var history_version = _history_version(opened_root)
			if history_version == null:
				return _failure("EDITOR_HISTORY_NOT_FOUND", "Godot did not expose an Undo/Redo history for the opened scene.")
			return {
				"opened": true,
				"previousScene": previous_scene,
				"scene": scene_path,
				"historyVersion": history_version,
			}
	var actual_root := _editor.get_edited_scene_root()
	return _failure("EDITOR_SCENE_OPEN_TIMEOUT", "The requested scene did not become the active edited scene before the deadline.", {
		"scenePath": scene_path,
		"actualScenePath": actual_root.scene_file_path if actual_root != null else null,
	})


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


func _scene_batch(params: Dictionary) -> Dictionary:
	var validated := _validate_batch(params)
	if validated.has("_error"):
		return validated
	var root: Node = validated.root
	var context := _create_batch_context(root)
	var plans: Array[Dictionary] = []
	var receipts: Array[Dictionary] = []
	var operations: Array = validated.operations
	for index in range(operations.size()):
		var operation: Dictionary = operations[index]
		var planned := _plan_batch_operation(context, operation, index)
		if planned.has("_error"):
			_cleanup_batch_context(context)
			return _batch_validation_failure(index, str(operation.get("op", "")), _batch_operation_hint_path(operation), planned)
		plans.append(planned)
		receipts.append({
			"index": index,
			"op": str(operation.op),
			"path": str(planned.path),
			"action": str(planned.action),
		})

	var full_action_name := "Agent batch: %s" % validated.actionName
	_undo_redo.create_action(full_action_name, UndoRedo.MERGE_DISABLE, root)
	for plan in plans:
		_register_batch_do_operation(root, plan)
	for plan_index in range(plans.size() - 1, -1, -1):
		_register_batch_undo_operation(root, plans[plan_index])
	_undo_redo.commit_action()
	var history_version = _history_version(root)
	_batch_dirty_versions[root.scene_file_path] = history_version
	return {
		"scenePath": root.scene_file_path,
		"actionName": full_action_name,
		"operationCount": plans.size(),
		"results": receipts,
		"undoable": true,
		"dirty": true,
		"historyVersion": history_version,
	}


func _validate_batch(params: Dictionary) -> Dictionary:
	var required := _require_edited_scene(params)
	if required.has("_error"):
		return required
	if str(params.get("expectedProjectFingerprint", "")).is_empty():
		return _failure("PROJECT_FINGERPRINT_REQUIRED", "expectedProjectFingerprint is required for editor batches.")
	var operations = params.get("operations", null)
	if typeof(operations) != TYPE_ARRAY or operations.size() < 1 or operations.size() > 32:
		return _failure("EDITOR_BATCH_VALIDATION_FAILED", "operations must contain between 1 and 32 entries.", {"operationCount": operations.size() if typeof(operations) == TYPE_ARRAY else null})
	var confirm_destructive := bool(params.get("confirmDestructive", false))
	var supported := ["node_create", "node_update", "node_move", "node_delete", "scene_instantiate", "resource_create", "resource_update", "instance_set_editable", "signal_connect"]
	for index in range(operations.size()):
		if typeof(operations[index]) != TYPE_DICTIONARY:
			return _failure("EDITOR_BATCH_VALIDATION_FAILED", "Every operation must be an object.", {"index": index})
		var operation: Dictionary = operations[index]
		var op := str(operation.get("op", ""))
		if op not in supported:
			return _failure("EDITOR_BATCH_VALIDATION_FAILED", "Batch operation is not supported.", {"index": index, "op": op})
		if op == "node_delete" and not confirm_destructive:
			return _failure("EDITOR_BATCH_VALIDATION_FAILED", "node_delete requires confirmDestructive=true.", {"index": index, "op": op})
	var action_name := str(params.get("actionName", "Scene batch"))
	if action_name.is_empty() or action_name.length() > 120:
		return _failure("EDITOR_BATCH_VALIDATION_FAILED", "actionName must contain between 1 and 120 characters.")
	return {"root": required.root, "operations": operations, "actionName": action_name}


func _create_batch_context(root: Node) -> Dictionary:
	var context := {
		"root": root,
		"rootPath": "/root/%s" % root.name,
		"index": {},
		"children": {},
		"createdRoots": [],
		"propertyValues": {},
		"editableValues": {},
		"connections": {},
	}
	_index_batch_subtree(context, root, str(context.rootPath), "")
	return context


func _index_batch_subtree(context: Dictionary, node: Node, path: String, parent_path: String) -> void:
	context.index[path] = {
		"node": node,
		"path": path,
		"parentPath": parent_path,
		"name": path.get_file(),
	}
	if not context.children.has(parent_path):
		context.children[parent_path] = []
	var siblings: Array = context.children[parent_path]
	if path not in siblings:
		siblings.append(path)
	context.children[parent_path] = siblings
	if not context.children.has(path):
		context.children[path] = []
	for child in node.get_children():
		_index_batch_subtree(context, child, path.path_join(str(child.name)), path)


func _batch_operation_hint_path(operation: Dictionary) -> String:
	match str(operation.get("op", "")):
		"node_create":
			return str(operation.get("parentPath", "")).path_join(str(operation.get("name", "")))
		"scene_instantiate":
			return str(operation.get("parentPath", "")).path_join(str(operation.get("name", operation.get("scenePath", ""))))
		"node_update", "node_move", "node_delete", "resource_create", "resource_update", "instance_set_editable":
			return str(operation.get("nodePath", ""))
		"signal_connect":
			return str(operation.get("sourcePath", ""))
	return ""


func _batch_validation_failure(index: int, op: String, path: String, cause: Dictionary) -> Dictionary:
	var error: Dictionary = cause.get("_error", {})
	return _failure("EDITOR_BATCH_VALIDATION_FAILED", "Batch operation failed validation before any editor mutation was registered.", {
		"index": index,
		"op": op,
		"path": path,
		"causeCode": str(error.get("code", "EDITOR_BATCH_VALIDATION_FAILED")),
		"causeDetails": error.get("details", {}),
	})


func _cleanup_batch_context(context: Dictionary) -> void:
	for value in context.createdRoots:
		if value is Node and is_instance_valid(value) and not (value as Node).is_inside_tree():
			(value as Node).free()


func _batch_entry(context: Dictionary, path: String, code: String = "EDITOR_NODE_NOT_FOUND") -> Dictionary:
	if not context.index.has(path):
		return _failure(code, "Node was not found in the logical batch scene.", {"nodePath": path})
	return context.index[path]


func _batch_property_key(object: Object, property: String) -> String:
	return "%d:%s" % [object.get_instance_id(), property]


func _batch_current_property(context: Dictionary, object: Object, property: String) -> Variant:
	var key := _batch_property_key(object, property)
	return context.propertyValues[key] if context.propertyValues.has(key) else object.get(property)


func _batch_set_property(context: Dictionary, object: Object, property: String, value: Variant) -> void:
	context.propertyValues[_batch_property_key(object, property)] = value


func _prepare_batch_properties(context: Dictionary, object: Object, raw: Variant) -> Dictionary:
	var prepared := _prepare_properties(object, raw)
	if prepared.has("_error"):
		return prepared
	for change in prepared.changes:
		var property := str(change.property)
		change.previous = _batch_current_property(context, object, property)
		_batch_set_property(context, object, property, change.value)
	return prepared


func _rewrite_batch_path(path: String, old_path: String, new_path: String) -> String:
	if path == old_path:
		return new_path
	if path.begins_with(old_path + "/"):
		return new_path + path.trim_prefix(old_path)
	return path


func _rewrite_batch_paths(context: Dictionary, old_path: String, new_path: String) -> void:
	var rewritten_index := {}
	for key_value in context.index.keys():
		var key := str(key_value)
		var rewritten := _rewrite_batch_path(key, old_path, new_path)
		var entry: Dictionary = context.index[key]
		entry.path = rewritten
		entry.parentPath = _rewrite_batch_path(str(entry.parentPath), old_path, new_path)
		rewritten_index[rewritten] = entry
	context.index = rewritten_index

	var rewritten_children := {}
	for parent_value in context.children.keys():
		var parent_path := _rewrite_batch_path(str(parent_value), old_path, new_path)
		var paths: Array = []
		for child_value in context.children[parent_value]:
			paths.append(_rewrite_batch_path(str(child_value), old_path, new_path))
		rewritten_children[parent_path] = paths
	context.children = rewritten_children
	context.rootPath = _rewrite_batch_path(str(context.rootPath), old_path, new_path)


func _remove_batch_subtree(context: Dictionary, path: String) -> void:
	var entry: Dictionary = context.index[path]
	var parent_path := str(entry.parentPath)
	if context.children.has(parent_path):
		var siblings: Array = context.children[parent_path]
		siblings.erase(path)
		context.children[parent_path] = siblings
	var removed: Array[String] = []
	for key_value in context.index.keys():
		var key := str(key_value)
		if key == path or key.begins_with(path + "/"):
			removed.append(key)
	for key in removed:
		context.index.erase(key)
		context.children.erase(key)


func _plan_batch_operation(context: Dictionary, operation: Dictionary, _index: int) -> Dictionary:
	var op := str(operation.get("op", ""))
	var root: Node = context.root
	match op:
		"node_create":
			var parent_path := str(operation.get("parentPath", ""))
			var parent_entry := _batch_entry(context, parent_path, "EDITOR_PARENT_NOT_FOUND")
			if parent_entry.has("_error"):
				return parent_entry
			var type_name := str(operation.get("type", ""))
			if type_name.is_empty() or not ClassDB.class_exists(type_name) or not ClassDB.can_instantiate(type_name) or not ClassDB.is_parent_class(type_name, "Node"):
				return _failure("EDITOR_NODE_TYPE_INVALID", "type must name an instantiable Node class.", {"type": type_name})
			var node_name := str(operation.get("name", ""))
			var name_error := _validate_node_name(node_name)
			if not name_error.is_empty():
				return _failure("EDITOR_NODE_NAME_INVALID", name_error, {"name": node_name})
			var path := parent_path.path_join(node_name)
			if context.index.has(path):
				return _failure("EDITOR_NODE_NAME_CONFLICT", "Parent already has a logical child with this name.", {"parentPath": parent_path, "name": node_name})
			var instance = ClassDB.instantiate(type_name)
			if not instance is Node:
				if instance != null:
					instance.free()
				return _failure("EDITOR_NODE_CREATE_FAILED", "Godot could not instantiate the requested Node type.", {"type": type_name})
			var node := instance as Node
			node.name = node_name
			var prepared := _prepare_batch_properties(context, node, operation.get("properties", {}))
			if prepared.has("_error"):
				node.free()
				return prepared
			context.createdRoots.append(node)
			_index_batch_subtree(context, node, path, parent_path)
			return {"kind": op, "action": "create", "path": path, "node": node, "parent": parent_entry.node, "prepared": prepared}

		"scene_instantiate":
			var parent_path := str(operation.get("parentPath", ""))
			var parent_entry := _batch_entry(context, parent_path, "EDITOR_PARENT_NOT_FOUND")
			if parent_entry.has("_error"):
				return parent_entry
			var checked_path := _validated_res_path(str(operation.get("scenePath", "")), ["tscn"])
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
			if operation.has("name"):
				var name_error := _validate_node_name(str(operation.name))
				if not name_error.is_empty():
					instance.free()
					return _failure("EDITOR_NODE_NAME_INVALID", name_error, {"name": str(operation.name)})
				instance.name = str(operation.name)
			var path := parent_path.path_join(str(instance.name))
			if context.index.has(path):
				instance.free()
				return _failure("EDITOR_NODE_NAME_CONFLICT", "Parent already has a logical child with this name.", {"parentPath": parent_path, "name": str(instance.name)})
			var prepared := _prepare_batch_properties(context, instance, operation.get("properties", {}))
			if prepared.has("_error"):
				instance.free()
				return prepared
			context.createdRoots.append(instance)
			_index_batch_subtree(context, instance, path, parent_path)
			return {"kind": op, "action": "instantiate", "path": path, "node": instance, "parent": parent_entry.node, "prepared": prepared}

		"node_update":
			var path := str(operation.get("nodePath", ""))
			var entry := _batch_entry(context, path)
			if entry.has("_error"):
				return entry
			var node: Node = entry.node
			var prepared := _prepare_batch_properties(context, node, operation.get("properties", {}))
			if prepared.has("_error"):
				return prepared
			var name_changed := false
			var old_name := str(entry.name)
			var new_name := old_name
			if operation.has("name"):
				new_name = str(operation.name)
				var name_error := _validate_node_name(new_name)
				if not name_error.is_empty():
					return _failure("EDITOR_NODE_NAME_INVALID", name_error, {"name": new_name})
				name_changed = new_name != old_name
				var new_path := str(entry.parentPath).path_join(new_name) if not str(entry.parentPath).is_empty() else "/root/%s" % new_name
				if name_changed and context.index.has(new_path):
					return _failure("EDITOR_NODE_NAME_CONFLICT", "Parent already has a logical child with this name.", {"name": new_name})
				if name_changed:
					entry.name = new_name
					context.index[path] = entry
					_rewrite_batch_paths(context, path, new_path)
					path = new_path
			if not name_changed and prepared.names.is_empty():
				return _failure("EDITOR_UPDATE_EMPTY", "Update requires name or at least one property.")
			return {"kind": op, "action": "update", "path": path, "node": node, "prepared": prepared, "nameChanged": name_changed, "oldName": old_name, "newName": new_name}

		"node_move":
			var path := str(operation.get("nodePath", ""))
			var parent_path := str(operation.get("newParentPath", ""))
			var entry := _batch_entry(context, path)
			if entry.has("_error"):
				return entry
			var parent_entry := _batch_entry(context, parent_path, "EDITOR_PARENT_NOT_FOUND")
			if parent_entry.has("_error"):
				return parent_entry
			if path == str(context.rootPath):
				return _failure("EDITOR_ROOT_MOVE_REJECTED", "The edited scene root cannot be moved.")
			if parent_path == path or parent_path.begins_with(path + "/"):
				return _failure("EDITOR_MOVE_CYCLE", "A node cannot be moved below itself or one of its descendants.")
			var old_parent_path := str(entry.parentPath)
			var new_path := parent_path.path_join(str(entry.name))
			if new_path != path and context.index.has(new_path):
				return _failure("EDITOR_NODE_NAME_CONFLICT", "New parent already has a logical child with this name.", {"name": str(entry.name)})
			var old_siblings: Array = context.children.get(old_parent_path, [])
			var old_index := old_siblings.find(path)
			var new_siblings: Array = context.children.get(parent_path, [])
			var maximum := new_siblings.size() if old_parent_path != parent_path else maxi(new_siblings.size() - 1, 0)
			var requested_index := int(operation.get("index", -1))
			if requested_index < -1 or requested_index > maximum:
				return _failure("EDITOR_CHILD_INDEX_INVALID", "index is outside the new parent's logical child range.", {"index": requested_index, "maximum": maximum})
			var same_parent_no_op := old_parent_path == parent_path and requested_index < 0
			if not same_parent_no_op:
				old_siblings.erase(path)
				context.children[old_parent_path] = old_siblings
				new_siblings = context.children.get(parent_path, [])
				var final_index := new_siblings.size() if requested_index < 0 else requested_index
				new_siblings.insert(final_index, path)
				context.children[parent_path] = new_siblings
				entry.parentPath = parent_path
				context.index[path] = entry
				_rewrite_batch_paths(context, path, new_path)
			return {"kind": op, "action": "move", "path": new_path, "node": entry.node, "oldParent": context.index[old_parent_path].node, "newParent": parent_entry.node, "oldIndex": old_index, "index": requested_index, "keepGlobalTransform": bool(operation.get("keepGlobalTransform", true)), "sameParentNoOp": same_parent_no_op}

		"node_delete":
			var path := str(operation.get("nodePath", ""))
			var entry := _batch_entry(context, path)
			if entry.has("_error"):
				return entry
			if path == str(context.rootPath):
				return _failure("EDITOR_ROOT_DELETE_REJECTED", "The edited scene root cannot be deleted.")
			var parent_path := str(entry.parentPath)
			var parent_entry := _batch_entry(context, parent_path, "EDITOR_PARENT_NOT_FOUND")
			if parent_entry.has("_error"):
				return parent_entry
			var siblings: Array = context.children.get(parent_path, [])
			var child_index := siblings.find(path)
			var node: Node = entry.node
			var owner = node.owner if node.is_inside_tree() else root
			_remove_batch_subtree(context, path)
			return {"kind": op, "action": "delete", "path": path, "node": node, "parent": parent_entry.node, "index": child_index, "owner": owner}

		"resource_create":
			var node_path := str(operation.get("nodePath", ""))
			var entry := _batch_entry(context, node_path)
			if entry.has("_error"):
				return entry
			var node: Node = entry.node
			var property := str(operation.get("property", ""))
			var descriptor := _property_descriptor(node, property)
			if descriptor.is_empty():
				return _failure("EDITOR_PROPERTY_NOT_FOUND", "Target resource property does not exist.", {"nodePath": node_path, "property": property})
			if int(descriptor.usage) & PROPERTY_USAGE_READ_ONLY or int(descriptor.type) != TYPE_OBJECT:
				return _failure("EDITOR_RESOURCE_PROPERTY_INVALID", "Target property must be a writable Object/Resource property.", {"property": property})
			var type_name := str(operation.get("type", ""))
			if type_name.is_empty() or not ClassDB.class_exists(type_name) or not ClassDB.can_instantiate(type_name) or not ClassDB.is_parent_class(type_name, "Resource"):
				return _failure("EDITOR_RESOURCE_TYPE_INVALID", "type must name an instantiable Resource class.", {"type": type_name})
			var instance = ClassDB.instantiate(type_name)
			if not instance is Resource:
				return _failure("EDITOR_RESOURCE_CREATE_FAILED", "Godot could not instantiate the requested Resource type.", {"type": type_name})
			var resource := instance as Resource
			var required_class := _resource_class_from_descriptor(descriptor)
			if not required_class.is_empty() and not resource.is_class(required_class):
				return _failure("EDITOR_RESOURCE_CLASS_MISMATCH", "Resource type is incompatible with the target property.", {"type": type_name, "requiredClass": required_class, "property": property})
			var prepared := _prepare_batch_properties(context, resource, operation.get("properties", {}))
			if prepared.has("_error"):
				return prepared
			var previous = _batch_current_property(context, node, property)
			_batch_set_property(context, node, property, resource)
			return {"kind": op, "action": op, "path": node_path, "node": node, "property": property, "resource": resource, "previous": previous, "prepared": prepared}

		"resource_update":
			var node_path := str(operation.get("nodePath", ""))
			var entry := _batch_entry(context, node_path)
			if entry.has("_error"):
				return entry
			var node: Node = entry.node
			var property := str(operation.get("property", ""))
			if _property_descriptor(node, property).is_empty():
				return _failure("EDITOR_PROPERTY_NOT_FOUND", "Resource property does not exist.", {"nodePath": node_path, "property": property})
			var value = _batch_current_property(context, node, property)
			if not value is Resource:
				return _failure("EDITOR_RESOURCE_VALUE_REQUIRED", "The selected node property does not contain a Resource.", {"nodePath": node_path, "property": property})
			var resource := value as Resource
			var prepared := _prepare_batch_properties(context, resource, operation.get("properties", {}))
			if prepared.has("_error"):
				return prepared
			if prepared.names.is_empty():
				return _failure("EDITOR_UPDATE_EMPTY", "Resource update requires at least one property.")
			return {"kind": op, "action": op, "path": node_path, "resource": resource, "prepared": prepared}

		"instance_set_editable":
			var node_path := str(operation.get("nodePath", ""))
			var entry := _batch_entry(context, node_path)
			if entry.has("_error"):
				return entry
			var node: Node = entry.node
			if node == root or node.scene_file_path.is_empty():
				return _failure("EDITOR_PACKED_SCENE_INSTANCE_REQUIRED", "Node must be the root of an instantiated PackedScene.", {"nodePath": node_path})
			var key := str(node.get_instance_id())
			var previous: bool = bool(context.editableValues.get(key, root.is_editable_instance(node) if node.is_inside_tree() else false))
			var editable := bool(operation.get("editable", true))
			if previous == editable:
				return _failure("EDITOR_INSTANCE_EDITABLE_UNCHANGED", "PackedScene editable state already has the requested value.", {"nodePath": node_path, "editable": editable})
			context.editableValues[key] = editable
			return {"kind": op, "action": op, "path": node_path, "node": node, "previous": previous, "editable": editable}

		"signal_connect":
			var source_path := str(operation.get("sourcePath", ""))
			var target_path := str(operation.get("targetPath", ""))
			var source_entry := _batch_entry(context, source_path, "EDITOR_SIGNAL_NODE_NOT_FOUND")
			var target_entry := _batch_entry(context, target_path, "EDITOR_SIGNAL_NODE_NOT_FOUND")
			if source_entry.has("_error") or target_entry.has("_error"):
				return _failure("EDITOR_SIGNAL_NODE_NOT_FOUND", "Signal source or target node was not found in the logical batch scene.", {"sourcePath": source_path, "targetPath": target_path})
			var source: Node = source_entry.node
			var target: Node = target_entry.node
			var signal_name := str(operation.get("signal", ""))
			var method := str(operation.get("method", ""))
			if signal_name.is_empty() or not source.has_signal(signal_name):
				return _failure("EDITOR_SIGNAL_NOT_FOUND", "Source does not declare the requested signal.", {"signal": signal_name})
			if method.is_empty() or not target.has_method(method):
				return _failure("EDITOR_SIGNAL_METHOD_NOT_FOUND", "Target method was not found.", {"method": method})
			var callable := Callable(target, method)
			var connection_key := "%d:%s:%d:%s" % [source.get_instance_id(), signal_name, target.get_instance_id(), method]
			if source.is_connected(signal_name, callable) or context.connections.has(connection_key):
				return _failure("EDITOR_SIGNAL_ALREADY_CONNECTED", "This signal connection already exists.", {"signal": signal_name})
			context.connections[connection_key] = true
			var allowed_flags := CONNECT_DEFERRED | CONNECT_PERSIST | CONNECT_ONE_SHOT | CONNECT_REFERENCE_COUNTED
			var flags := int(operation.get("flags", CONNECT_PERSIST)) & allowed_flags
			flags |= CONNECT_PERSIST
			return {"kind": op, "action": op, "path": source_path, "source": source, "target": target, "signal": signal_name, "method": method, "callable": callable, "flags": flags}

	return _failure("EDITOR_BATCH_OPERATION_UNKNOWN", "Batch operation is not supported.", {"op": op})


func _register_batch_do_operation(root: Node, plan: Dictionary) -> void:
	match str(plan.kind):
		"node_create", "scene_instantiate":
			_undo_redo.add_do_method(plan.parent, "add_child", plan.node, true)
			_undo_redo.add_do_method(plan.node, "set_owner", root)
			for change in plan.prepared.changes:
				_undo_redo.add_do_property(plan.node, change.property, change.value)
			_undo_redo.add_do_reference(plan.node)
		"node_update":
			if bool(plan.nameChanged):
				_undo_redo.add_do_property(plan.node, "name", plan.newName)
			for change in plan.prepared.changes:
				_undo_redo.add_do_property(plan.node, change.property, change.value)
		"node_move":
			if not bool(plan.sameParentNoOp):
				if plan.oldParent != plan.newParent:
					_undo_redo.add_do_method(plan.node, "reparent", plan.newParent, plan.keepGlobalTransform)
				if int(plan.index) >= 0:
					_undo_redo.add_do_method(plan.newParent, "move_child", plan.node, plan.index)
		"node_delete":
			_undo_redo.add_do_method(plan.parent, "remove_child", plan.node)
		"resource_create":
			for change in plan.prepared.changes:
				_undo_redo.add_do_property(plan.resource, change.property, change.value)
			_undo_redo.add_do_property(plan.node, plan.property, plan.resource)
			_undo_redo.add_do_reference(plan.resource)
		"resource_update":
			for change in plan.prepared.changes:
				_undo_redo.add_do_property(plan.resource, change.property, change.value)
		"instance_set_editable":
			_undo_redo.add_do_method(root, "set_editable_instance", plan.node, plan.editable)
		"signal_connect":
			_undo_redo.add_do_method(plan.source, "connect", StringName(plan.signal), plan.callable, plan.flags)


func _register_batch_undo_operation(root: Node, plan: Dictionary) -> void:
	match str(plan.kind):
		"node_create", "scene_instantiate":
			_undo_redo.add_undo_method(plan.parent, "remove_child", plan.node)
		"node_update":
			if bool(plan.nameChanged):
				_undo_redo.add_undo_property(plan.node, "name", plan.oldName)
			for change in plan.prepared.changes:
				_undo_redo.add_undo_property(plan.node, change.property, change.previous)
		"node_move":
			if not bool(plan.sameParentNoOp):
				if plan.oldParent != plan.newParent:
					_undo_redo.add_undo_method(plan.node, "reparent", plan.oldParent, plan.keepGlobalTransform)
				_undo_redo.add_undo_method(plan.oldParent, "move_child", plan.node, plan.oldIndex)
		"node_delete":
			_undo_redo.add_undo_method(plan.parent, "add_child", plan.node, true)
			_undo_redo.add_undo_method(plan.parent, "move_child", plan.node, plan.index)
			_undo_redo.add_undo_method(plan.node, "set_owner", plan.owner)
			_undo_redo.add_undo_reference(plan.node)
		"resource_create":
			_undo_redo.add_undo_property(plan.node, plan.property, plan.previous)
		"resource_update":
			for change in plan.prepared.changes:
				_undo_redo.add_undo_property(plan.resource, change.property, change.previous)
		"instance_set_editable":
			_undo_redo.add_undo_method(root, "set_editable_instance", plan.node, plan.previous)
		"signal_connect":
			_undo_redo.add_undo_method(plan.source, "disconnect", StringName(plan.signal), plan.callable)


func _node_create(params: Dictionary) -> Dictionary:
	var required := _require_edited_scene(params)
	if required.has("_error"):
		return required
	var root: Node = required.root
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
		"historyVersion": _history_version(root),
	}


func _scene_instantiate(params: Dictionary) -> Dictionary:
	var required := _require_edited_scene(params)
	if required.has("_error"):
		return required
	var root: Node = required.root
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
		"historyVersion": _history_version(root),
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
	var required := _require_edited_scene(params)
	if required.has("_error"):
		return required
	var root: Node = required.root
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
		"historyVersion": _history_version(root),
	}


func _node_delete(params: Dictionary) -> Dictionary:
	var required := _require_edited_scene(params)
	if required.has("_error"):
		return required
	var root: Node = required.root
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
		"historyVersion": _history_version(root),
	}


func _node_move(params: Dictionary) -> Dictionary:
	var required := _require_edited_scene(params)
	if required.has("_error"):
		return required
	var root: Node = required.root
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
		"historyVersion": _history_version(root),
	}


func _resource_create(params: Dictionary) -> Dictionary:
	var required := _require_edited_scene(params)
	if required.has("_error"):
		return required
	var root: Node = required.root
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
		"historyVersion": _history_version(root),
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
	var required := _require_edited_scene(params)
	if required.has("_error"):
		return required
	var root: Node = required.root
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
		"historyVersion": _history_version(root),
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
	var required := _require_edited_scene(params)
	if required.has("_error"):
		return required
	var root: Node = required.root
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
		"historyVersion": _history_version(root),
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
	var required := _require_edited_scene(params)
	if required.has("_error"):
		return required
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
		"historyVersion": _history_version(root),
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
	var required := _require_edited_scene(params)
	if required.has("_error"):
		return required
	var root: Node = required.root
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
		"historyVersion": _history_version(root),
	}


func _scene_save(params: Dictionary) -> Dictionary:
	var required := _require_edited_scene(params)
	if required.has("_error"):
		return required
	var root: Node = required.root
	var guarded_history := _require_history_version(params, root)
	if guarded_history.has("_error"):
		return guarded_history
	var scene_path := root.scene_file_path
	var before_sha256 := FileAccess.get_sha256(scene_path) if FileAccess.file_exists(scene_path) else ""
	var batch_dirty: bool = _batch_dirty_versions.get(scene_path, null) == guarded_history.history.get_version()
	var error := _editor.save_scene()
	var after_sha256 := FileAccess.get_sha256(scene_path) if FileAccess.file_exists(scene_path) else ""
	if error != OK or not FileAccess.file_exists(scene_path) or (batch_dirty and before_sha256 == after_sha256):
		return _failure("EDITOR_SCENE_SAVE_FAILED", "Godot could not persist the edited scene.", {
			"error": error if error != OK else ERR_CANT_CREATE,
			"scene": scene_path,
			"beforeSha256": before_sha256,
			"afterSha256": after_sha256,
		})
	_batch_dirty_versions.erase(scene_path)
	return {"saved": true, "scene": scene_path, "error": error, "historyVersion": _history_version(root)}


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


func _history_step(action: String, params: Dictionary) -> Dictionary:
	var required := _require_edited_scene(params)
	if required.has("_error"):
		return required
	var root: Node = required.root
	var guarded_history := _require_history_version(params, root)
	if guarded_history.has("_error"):
		return guarded_history
	var history: UndoRedo = guarded_history.history
	var available := history.has_undo() if action == "undo" else history.has_redo()
	if not available:
		return _failure("EDITOR_HISTORY_EMPTY", "The edited scene has no action available to %s." % action, {"action": action})
	var before_version := history.get_version()
	var action_name := history.get_current_action_name() if action == "undo" else history.get_action_name(history.get_current_action() + 1)
	var expected_action_name := str(params.get("expectedActionName", ""))
	if not expected_action_name.is_empty() and expected_action_name != action_name:
		return _failure("EDITOR_HISTORY_ACTION_MISMATCH", "The next history action does not match expectedActionName.", {
			"expectedActionName": expected_action_name,
			"actualActionName": action_name,
		})
	var performed: bool
	if action == "undo":
		performed = history.undo()
	else:
		performed = history.redo()
	if not performed:
		return _failure("EDITOR_HISTORY_STEP_FAILED", "Godot could not %s the current scene action." % action, {"action": action})
	return {
		"action": action,
		"performed": true,
		"actionName": action_name,
		"beforeVersion": before_version,
		"afterVersion": history.get_version(),
		"historyVersion": history.get_version(),
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
