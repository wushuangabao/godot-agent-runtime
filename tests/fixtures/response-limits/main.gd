extends Node


func _ready() -> void:
	var payload := "x".repeat(4096)
	for node_index in range(9):
		var node := Node.new()
		node.name = "Payload%d" % node_index
		for metadata_index in range(32):
			node.set_meta("payload_%02d" % metadata_index, payload)
		add_child(node)
	print("GODOT_AGENT_RUNTIME_READY:response-limits")
