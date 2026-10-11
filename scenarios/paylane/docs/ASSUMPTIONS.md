# Assumptions

The brief is deliberately ambiguous. These are the calls I made, and why. Each one is easy to change.

<!-- Draft list: edit, cut, or reword in your own voice. -->

1. **Verification is a tool, not a judgment the model makes.** The spec has `get_customer` return `card_last4` and never says who flips `verified`. If the model sees the real digits it can be talked into repeating them, so I added `verify_customer(email, card_last4)`, which returns only yes or no. `get_customer` masks the digits.
2. **Refunds are tied to the verified customer.** `issue_refund(txn_id, amount)` takes no customer id, so as specced one customer could refund another's transaction. The guard checks ownership.
3. **The $75 limit applies to the transaction, not the refund.** A $50 partial refund of a $120 purchase still escalates.
4. **Boundaries are inclusive.** Exactly $75.00 and exactly 30 days old are auto-approved.
5. **"30 days" counts from the transaction date.**
6. **Pending transactions are not refunded.** They may still be reversed by the merchant; the agent explains and escalates.
7. **Three failed verification attempts lock verification** for the conversation, and the agent escalates.
8. **No "list transactions" tool.** If the customer says "refund my last purchase", the agent asks which transaction.
9. **Policy is enforced twice:** in the prompt (so the agent behaves well) and in code (so it cannot do the wrong thing even when it is talked into trying).

Questions I would ask Paylane before launch are in the customer note.
