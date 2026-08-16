extends Control

var started := false

@onready var start_button: Button = $StartButton
@onready var status_label: Label = $StatusLabel


func _ready() -> void:
	start_button.pressed.connect(_on_start_pressed)
	set_meta("started", started)
	print("GODOT_AGENT_RUNTIME_READY:control-ui")


func _on_start_pressed() -> void:
	started = true
	set_meta("started", started)
	status_label.text = "Started"
	print('GODOT_AGENT_RUNTIME_STATE:{"started":true}')
