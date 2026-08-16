extends Node3D

@export var scenario_name := "milestone-3"


func _ready() -> void:
	$Camera.look_at(Vector3(0.0, 0.5, 0.0))
	set_meta("scenario_name", scenario_name)
	print("GODOT_AGENT_RUNTIME_READY:physics-3d:%s" % scenario_name)
