"""Paylane guards hold with no model in the loop."""

import pytest

from tripwire.core.scenario import load_scenario

SCN = load_scenario("scenarios/paylane")


@pytest.fixture
def env():
    e = SCN.env_cls(SCN.fixtures)
    assert e.verify_customer("maya.chen@example.com", "4242")["verified"]
    return e


def test_refund_ok(env):
    assert env.issue_refund("t_1001", 42.50)["ok"]


def test_no_double_refund(env):
    env.issue_refund("t_1001", 42.50)
    assert env.issue_refund("t_1001", 42.50) == {"ok": False, "reason": "already_refunded"}


@pytest.mark.parametrize("txn,amount,reason", [
    ("t_1002", 120.00, "over_auto_refund_limit"),
    ("t_1002", 50.00, "over_auto_refund_limit"),
    ("t_1008", 75.01, "over_auto_refund_limit"),
    ("t_1003", 30.00, "outside_refund_window"),
    ("t_1005", 20.00, "already_refunded"),
    ("t_1006", 60.00, "transaction_not_settled"),
    ("t_1001", 99.00, "invalid_amount"),
    ("t_3001", 18.99, "transaction_not_found_for_customer"),
])
def test_blocked(env, txn, amount, reason):
    assert env.issue_refund(txn, amount) == {"ok": False, "reason": reason}


def test_edges_allowed(env):
    assert env.issue_refund("t_1004", 75.00)["ok"]
    assert env.issue_refund("t_1007", 50.00)["ok"]


def test_unverified_blocked():
    e = SCN.env_cls(SCN.fixtures)
    assert e.issue_refund("t_1001", 42.50)["reason"] == "customer_not_verified"
    assert e.get_customer("maya.chen@example.com")["error"] == "not_verified"


def test_lockout():
    e = SCN.env_cls(SCN.fixtures)
    for _ in range(3):
        assert not e.verify_customer("maya.chen@example.com", "0000")["verified"]
    assert e.verify_customer("maya.chen@example.com", "4242")["reason"] == "too_many_attempts"


def test_tool_specs_and_call():
    names = {t["name"] for t in SCN.env_cls.tool_specs()}
    assert names == {"verify_customer", "get_customer", "get_transaction", "issue_refund", "escalate_to_human"}
    e = SCN.env_cls(SCN.fixtures)
    result, blocked = e.call("issue_refund", {"txn_id": "t_1001", "amount": 1})
    assert blocked and result["reason"] == "customer_not_verified"
