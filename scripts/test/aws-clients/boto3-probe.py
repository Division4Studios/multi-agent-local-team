"""Original opt-in client assertions from MALT's committed STS/SQS contracts."""
import hashlib
import json
import os
import platform
import sys
import time

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

ACCOUNT = "000000000000"
MISSING_QUEUE = {"QueueDoesNotExist", "AWS.SimpleQueueService.NonExistentQueue"}


def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def check(name, action):
    try:
        result = action()
        emit({"event": "check", "name": name, "status": "passed"})
        return result
    except Exception:
        # Error bodies can contain request data. Only controlled step names leave
        # the container; the failed check is never credited as passing.
        emit({"event": "check", "name": name, "status": "failed"})
        raise


def unit(value):
    require(set(value) <= {"ResponseMetadata"}, "unexpected unit output fields")
    require(value.get("ResponseMetadata", {}).get("HTTPStatusCode") == 200, "unit status")


def expect_error(action, codes, operation=None):
    try:
        action()
    except ClientError as error:
        detail = error.response["Error"]
        require(detail["Code"] in codes, "wrong modeled error")
        require(error.response["ResponseMetadata"]["HTTPStatusCode"] == 400, "wrong error status")
        if operation:
            message = detail.get("Message", "")
            require(operation in message, "unsupported message omitted operation")
            require("unsupported" in message.lower() or "not supported" in message.lower(), "unsupported explanation")
        return
    raise AssertionError("expected modeled service failure")


class Probe:
    def __init__(self, case):
        endpoint = os.environ["AWS_ENDPOINT_URL"]
        region = os.environ["AWS_REGION"]
        self.name, self.body = case["queueName"], case["body"]
        self.url = f"{endpoint}/{ACCOUNT}/{region}/{self.name}"
        self.md5 = hashlib.md5(self.body.encode("utf-8"), usedforsecurity=False).hexdigest()
        config = Config(connect_timeout=3, read_timeout=5, retries={"total_max_attempts": 1, "mode": "standard"})
        self.sts = boto3.client("sts", endpoint_url=endpoint, region_name=region, config=config)
        self.sqs = boto3.client("sqs", endpoint_url=endpoint, region_name=region, config=config)
        self.created = False
        self.queue_cleanup = "not-created"

    def identity(self):
        value = self.sts.get_caller_identity()
        require(value["Account"] == ACCOUNT and value["UserId"] == ACCOUNT, "default identity")
        require(value["Arn"] == f"arn:aws:iam::{ACCOUNT}:root", "default root ARN")

    def create(self):
        self.queue_cleanup = "unconfirmed"
        value = self.sqs.create_queue(QueueName=self.name)
        self.created = True
        require(value["QueueUrl"] == self.url, "canonical creation URL")

    def get(self):
        value = self.sqs.get_queue_url(QueueName=self.name, QueueOwnerAWSAccountId=ACCOUNT)
        require(value["QueueUrl"] == self.url, "canonical lookup URL")

    def send(self):
        value = self.sqs.send_message(QueueUrl=self.url, MessageBody=self.body, DelaySeconds=0)
        require(isinstance(value["MessageId"], str) and value["MessageId"], "message identity")
        require(value["MD5OfMessageBody"] == self.md5, "send UTF-8 MD5")
        return value["MessageId"]

    def receive(self, message_id):
        value = self.sqs.receive_message(QueueUrl=self.url, MaxNumberOfMessages=1, VisibilityTimeout=0, WaitTimeSeconds=0)
        require(len(value.get("Messages", [])) == 1, "one delivery")
        message = value["Messages"][0]
        require(message["Body"] == self.body and message["MD5OfBody"] == self.md5, "exact body and MD5")
        require(message["MessageId"] == message_id, "delivery identity")
        require(isinstance(message["ReceiptHandle"], str) and message["ReceiptHandle"], "opaque receipt")
        return message["ReceiptHandle"]

    def absent_message(self):
        value = self.sqs.receive_message(QueueUrl=self.url, MaxNumberOfMessages=1, VisibilityTimeout=0, WaitTimeSeconds=0)
        require("Messages" not in value, "deleted zero-visibility delivery still present")

    def delete_queue(self):
        unit(self.sqs.delete_queue(QueueUrl=self.url))

    def absent_queue(self):
        expect_error(lambda: self.sqs.get_queue_url(QueueName=self.name), MISSING_QUEUE)
        self.created = False
        self.queue_cleanup = "confirmed"

    def cleanup_queue(self):
        def remove():
            try:
                self.delete_queue()
            except ClientError as error:
                require(error.response["Error"]["Code"] in MISSING_QUEUE, "cleanup deletion failed")
                require(error.response["ResponseMetadata"]["HTTPStatusCode"] == 400, "cleanup error status")
        check("cleanup.DeleteQueue", remove)
        check("cleanup.GetQueueUrl", self.absent_queue)

    def run(self):
        success = False
        try:
            check("sts.GetCallerIdentity", self.identity)
            check("sqs.CreateQueue", self.create)
            time.sleep(1.1)  # Allow the documented one-second queue readiness.
            check("sqs.GetQueueUrl", self.get)
            message_id = check("sqs.SendMessage", self.send)
            receipt = check("sqs.ReceiveMessage.zeroVisibility", lambda: self.receive(message_id))
            check("sqs.DeleteMessage", lambda: unit(self.sqs.delete_message(QueueUrl=self.url, ReceiptHandle=receipt)))
            check("sqs.ReceiveMessage.afterDelete", self.absent_message)
            check("sqs.DeleteQueue", self.delete_queue)
            check("sqs.GetQueueUrl.afterDelete", self.absent_queue)
            check("sqs.ListQueues.unsupported", lambda: expect_error(self.sqs.list_queues, {"UnsupportedOperation"}, "ListQueues"))
            success = True
        except Exception:
            pass
        finally:
            if self.created:
                try:
                    self.cleanup_queue()
                except Exception:
                    success = False
        emit({"event": "complete", "success": success, "queueCleanup": self.queue_cleanup})
        return success

    def cleanup_only(self):
        # The host invokes this mode only after observing this client's creation.
        self.created = True
        self.queue_cleanup = "unconfirmed"
        success = False
        try:
            self.cleanup_queue()
            success = True
        except Exception:
            pass
        emit({"event": "complete", "success": success, "queueCleanup": self.queue_cleanup})
        return success


def main():
    try:
        emit({"event": "version", "boto3": boto3.__version__, "python": platform.python_version()})
        require(boto3.__version__ == "1.42.97", "pinned Boto3 version")
        require(sys.version_info[:2] == (3, 13), "pinned Python interpreter family")
        case = json.loads(sys.argv[1])
        probe = Probe(case)
        try:
            return probe.cleanup_only() if case.get("cleanupOnly") else probe.run()
        finally:
            probe.sts.close()
            probe.sqs.close()
    except Exception:
        emit({"event": "fatal", "message": "SDK setup or version verification failed"})
        return False


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
