extends CharacterBody3D

@export var speed := 3.5
@export var gravity := 18.0

var physics_ticks := 0
var _start_position := Vector3.ZERO


func _ready() -> void:
	_start_position = position
	_record_state()


func _physics_process(delta: float) -> void:
	physics_ticks += 1
	if not is_on_floor():
		velocity.y -= gravity * delta
	else:
		velocity.y = 0.0
	velocity.x = Input.get_axis("ui_left", "ui_right") * speed
	velocity.z = 0.0
	move_and_slide()
	_record_state()


func _record_state() -> void:
	set_meta("physics_ticks", physics_ticks)
	set_meta("distance", absf(position.x - _start_position.x))
