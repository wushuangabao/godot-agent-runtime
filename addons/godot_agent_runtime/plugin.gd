@tool
extends EditorPlugin

var _bridge: Node


func _enter_tree() -> void:
	if OS.get_environment("GODOT_AGENT_RUNTIME_PORT").is_empty():
		return
	if get_editor_interface().get_edited_scene_root() == null:
		call_deferred("_open_main_scene")
	_bridge = preload("editor_bridge.gd").new()
	_bridge.name = "GodotAgentEditorBridge"
	_bridge.configure(get_editor_interface(), get_undo_redo())
	add_child(_bridge)


func _open_main_scene() -> void:
	var main_scene := str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if not main_scene.is_empty() and get_editor_interface().get_edited_scene_root() == null:
		get_editor_interface().open_scene_from_path(main_scene)


func _exit_tree() -> void:
	if _bridge != null:
		_bridge.queue_free()
		_bridge = null
