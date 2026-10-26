"""Independent offline audit of the frozen Kombu artifact; no repair changes."""

import json
import sys
from unittest.mock import Mock, patch

from kombu import Connection, Consumer, Producer, Queue
from kombu.transport.SQS import Channel as SQSChannel
from kombu.utils.json import dumps


def memory_case(kind):
    with Connection("memory://") as connection:
        channel = connection.channel()
        channel.state.clear()
        queue = Queue(
            "audit-" + kind, queue_arguments={"x-single-active-consumer": True}
        )
        consumer = Consumer(channel, [queue], callbacks=[lambda body, msg: None])
        consumer.consume()
        tag = consumer._active_tags[queue.name]
        before = consumer.consuming_from_sac(queue)
        if kind == "cancel":
            channel.basic_cancel(tag)
            out = {
                "registered_before": before,
                "registry_count": channel.get_consumer_count(queue.name),
                "consumer_reports_registered": consumer.consuming_from_sac(queue),
            }
            consumer.consume()
            out["registry_count_after_reconsume"] = channel.get_consumer_count(
                queue.name
            )
            assert out == {
                "registered_before": True,
                "registry_count": 0,
                "consumer_reports_registered": True,
                "registry_count_after_reconsume": 0,
            }
            return out
        if kind == "close":
            channel.close()
            out = {}
            for name, query in [
                ("consuming_from_sac", lambda: consumer.consuming_from_sac(queue)),
                ("is_active_on", lambda: consumer.is_active_on(queue)),
                ("active_consumer_tags", lambda: consumer.active_consumer_tags),
            ]:
                try:
                    out[name] = query()
                except Exception as exc:
                    out[name] = {"error": type(exc).__name__, "message": str(exc)}
            assert all(v["error"] == "AttributeError" for v in out.values())
            return out
        second = connection.channel()
        received = []
        second.basic_consume(
            queue.name,
            True,
            lambda msg: received.append(msg),
            tag,
            arguments={"x-priority": 10},
        )
        Producer(connection).publish("audit", routing_key=queue.name)
        connection.drain_events(timeout=0.5)
        out = {
            "first_channel_record_active": channel.list_consumers()[0]["is_active"],
            "consumer_reports_active": consumer.is_active_on(queue),
            "consumer_active_tags_count": len(consumer.active_consumer_tags),
            "second_received": len(received),
        }
        assert out == {
            "first_channel_record_active": False,
            "consumer_reports_active": True,
            "consumer_active_tags_count": 1,
            "second_received": 1,
        }
        second.basic_cancel(tag)
        out["first_active_after_failover"] = consumer.is_active_on(queue)
        assert out["first_active_after_failover"] is True
        return out


def sqs_case(low_no_ack, sac):
    backend = Mock()
    backend.get_queue_attributes.return_value = {
        "Attributes": {"ApproximateNumberOfMessages": "1"}
    }
    with (
        patch.object(SQSChannel, "sqs", return_value=backend),
        patch.object(SQSChannel, "asynsqs", return_value=backend),
    ):
        # Only AWS service calls are substituted. Conversion, dispatch, QoS and ack are real.
        connection = Connection(
            "sqs://a:b@",
            transport_options={
                "predefined_queues": {"jobs": {"url": "https://example.invalid/jobs"}}
            },
        )
        low, high = connection.channel(), connection.channel()
        low.queue_declare("jobs", arguments={"x-single-active-consumer": sac})
        received = []
        low.basic_consume(
            "jobs",
            low_no_ack,
            lambda msg: received.append(("low", msg)),
            "low",
            arguments={"x-priority": 0},
        )
        high.basic_consume(
            "jobs",
            False,
            lambda msg: received.append(("high", msg)),
            "high",
            arguments={"x-priority": 10},
        )
        payload = low.prepare_message(
            "audit",
            properties={
                "delivery_tag": "producer-tag",
                "delivery_info": {"exchange": "", "routing_key": "jobs"},
            },
        )
        backend.receive_message.return_value = {
            "Messages": [{"Body": dumps(payload), "ReceiptHandle": "audit-receipt"}]
        }
        low._get_bulk("jobs")
        selected, message = received[0]
        out = {
            "selected": selected,
            "deleted_before_ack": backend.delete_message.call_count,
            "receipt_preserved": "sqs_message" in message.delivery_info,
        }
        message.ack()
        out["deleted_after_ack"] = backend.delete_message.call_count
        connection.close()
        assert selected == "high"
        assert out["deleted_before_ack"] == int(low_no_ack)
        assert out["receipt_preserved"] == (not low_no_ack)
        assert out["deleted_after_ack"] == 1
        return out


result = {}
if "--sqs-only" not in sys.argv:
    result["cancel"] = memory_case("cancel")
    result["close"] = memory_case("close")
    result["duplicate_tag"] = memory_case("duplicate")
for sac in (True, False):
    for low_no_ack in (False, True):
        result[f"sqs_sac={sac}_standby_no_ack={low_no_ack}"] = sqs_case(low_no_ack, sac)
print(json.dumps(result, indent=2))
