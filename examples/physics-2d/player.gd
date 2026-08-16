extends CharacterBody2D

@export var speed := 180.0
@export var gravity := 720.0

var physics_ticks := 0


func _ready() -> void:
	_record_state()


func _physics_process(delta: float) -> void:
	physics_ticks += 1
	if not is_on_floor():
		velocity.y += gravity * delta
	velocity.x = Input.get_axis("ui_left", "ui_right") * speed
	move_and_slide()
	_record_state()


func _record_state() -> void:
	set_meta("physics_ticks", physics_ticks)
	set_meta("distance", position.x)
	set_meta("input_strength", Input.get_action_raw_strength("ui_right"))
