"""Synthetic Stubber fault controls; never gateway compatibility evidence."""
import contextlib
import io
import unittest

from botocore.stub import Stubber


def capture_action(action):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        result = action()
    return result, [json.loads(line) for line in output.getvalue().splitlines()]


class RecoveryControls(unittest.TestCase):
    def setUp(self):
        self.probe = Probe({"queueName": "malt-synthetic-recovery-control", "body": "synthetic control body"})
        self.sts = Stubber(self.probe.sts)
        self.sqs = Stubber(self.probe.sqs)
        self.sts.activate()
        self.sqs.activate()
        self.addCleanup(self.probe.sts.close)
        self.addCleanup(self.probe.sqs.close)
        self.addCleanup(self.sts.deactivate)
        self.addCleanup(self.sqs.deactivate)

    def before_delete(self):
        probe = self.probe
        self.sts.add_response("get_caller_identity", {"Account": ACCOUNT, "UserId": ACCOUNT, "Arn": f"arn:aws:iam::{ACCOUNT}:root"}, {})
        self.sqs.add_response("create_queue", {"QueueUrl": probe.url}, {"QueueName": probe.name})
        self.sqs.add_response("get_queue_url", {"QueueUrl": probe.url}, {"QueueName": probe.name, "QueueOwnerAWSAccountId": ACCOUNT})
        self.sqs.add_response("send_message", {"MessageId": "synthetic-id", "MD5OfMessageBody": probe.md5},
                              {"QueueUrl": probe.url, "MessageBody": probe.body, "DelaySeconds": 0})
        receive = {"QueueUrl": probe.url, "MaxNumberOfMessages": 1, "VisibilityTimeout": 0, "WaitTimeSeconds": 0}
        self.sqs.add_response("receive_message", {"Messages": [{"Body": probe.body, "MD5OfBody": probe.md5,
                              "MessageId": "synthetic-id", "ReceiptHandle": "synthetic-receipt"}]}, receive)
        self.sqs.add_response("delete_message", {"ResponseMetadata": {"HTTPStatusCode": 200}},
                              {"QueueUrl": probe.url, "ReceiptHandle": "synthetic-receipt"})
        self.sqs.add_response("receive_message", {}, receive)

    def delete(self, error=None):
        params = {"QueueUrl": self.probe.url}
        if error:
            self.sqs.add_client_error("delete_queue", service_error_code=error, http_status_code=400, expected_params=params)
        else:
            self.sqs.add_response("delete_queue", {"ResponseMetadata": {"HTTPStatusCode": 200}}, params)

    def lookup(self, error=None):
        params = {"QueueName": self.probe.name}
        if error:
            self.sqs.add_client_error("get_queue_url", service_error_code=error, http_status_code=400, expected_params=params)
        else:
            self.sqs.add_response("get_queue_url", {"QueueUrl": self.probe.url}, params)

    def verify(self, action, success, cleanup):
        result, events = capture_action(action)
        self.assertEqual(result, success)
        self.assertEqual(self.probe.created, cleanup != "confirmed")
        self.assertEqual(self.probe.queue_cleanup, cleanup)
        self.assertEqual(events[-1], {"event": "complete", "success": success, "queueCleanup": cleanup})
        self.sts.assert_no_pending_responses()
        self.sqs.assert_no_pending_responses()
        return [event for event in events if event["event"] == "check"]

    def test_main_and_fallback_delete_success_with_queue_still_present(self):
        self.before_delete()
        self.delete()
        self.lookup()
        self.delete()
        self.lookup()
        checks = self.verify(self.probe.run, False, "unconfirmed")
        self.assertEqual(checks[-3:], [
            {"event": "check", "name": "sqs.GetQueueUrl.afterDelete", "status": "failed"},
            {"event": "check", "name": "cleanup.DeleteQueue", "status": "passed"},
            {"event": "check", "name": "cleanup.GetQueueUrl", "status": "failed"},
        ])

    def test_failed_main_lookup_then_verified_fallback_preserves_failure(self):
        self.before_delete()
        self.delete()
        self.lookup("InternalError")
        self.delete("QueueDoesNotExist")
        self.lookup("QueueDoesNotExist")
        checks = self.verify(self.probe.run, False, "confirmed")
        self.assertIn({"event": "check", "name": "sqs.GetQueueUrl.afterDelete", "status": "failed"}, checks)
        self.assertEqual(checks[-1], {"event": "check", "name": "cleanup.GetQueueUrl", "status": "passed"})

    def test_cleanup_only_delete_acknowledgement_needs_absence(self):
        self.delete()
        self.lookup()
        checks = self.verify(self.probe.cleanup_only, False, "unconfirmed")
        self.assertEqual(checks, [
            {"event": "check", "name": "cleanup.DeleteQueue", "status": "passed"},
            {"event": "check", "name": "cleanup.GetQueueUrl", "status": "failed"},
        ])

    def test_cleanup_only_missing_delete_still_requires_lookup(self):
        self.delete("QueueDoesNotExist")
        self.lookup("InternalError")
        checks = self.verify(self.probe.cleanup_only, False, "unconfirmed")
        self.assertEqual(checks[-1], {"event": "check", "name": "cleanup.GetQueueUrl", "status": "failed"})

    def test_cleanup_only_failure_reports_the_executed_check_and_outcome(self):
        self.delete("InternalError")
        checks = self.verify(self.probe.cleanup_only, False, "unconfirmed")
        self.assertEqual(checks, [{"event": "check", "name": "cleanup.DeleteQueue", "status": "failed"}])

    def test_cleanup_only_success_requires_observed_absence(self):
        self.delete("QueueDoesNotExist")
        self.lookup("QueueDoesNotExist")
        checks = self.verify(self.probe.cleanup_only, True, "confirmed")
        self.assertEqual(checks, [
            {"event": "check", "name": "cleanup.DeleteQueue", "status": "passed"},
            {"event": "check", "name": "cleanup.GetQueueUrl", "status": "passed"},
        ])


suite = unittest.defaultTestLoader.loadTestsFromTestCase(RecoveryControls)
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(0 if result.wasSuccessful() else 1)
