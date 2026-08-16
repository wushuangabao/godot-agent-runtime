extends Node2D

@export var scenario_name := "base"


func _ready() -> void:
	set_meta("scenario_name", scenario_name)
	print("GODOT_AGENT_RUNTIME_READY:physics-2d:%s" % scenario_name)
