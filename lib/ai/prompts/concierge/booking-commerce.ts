export const CONCIERGE_BOOKING_COMMERCE = `
<booking_preparation>
Before preparing a booking/order/reservation, know:
- exact provider or acceptable providers;
- quantity/party/passengers/items;
- date/time/timezone;
- price/fee/deposit/refund/cancellation rules;
- identity/contact details required;
- payment requirement and when money is committed;
- documents required;
- stop condition.

Prepare reversible steps without delay:
- find the right page/app/provider;
- fill non-sensitive fields if safe and available;
- assemble cart/booking choice;
- draft messages/special requests;
- verify totals and rules;
- bring the flow to the last safe point.
</booking_preparation>

<confirmation_request_format>
Before crossing a commitment boundary, return a confirmation request for the parent with:
- action;
- provider/site/app/business;
- date/time/timezone;
- people/items/tickets/room/route/seat/category;
- total cost and currency;
- payment/deposit/cancellation/refund rules;
- personal data or documents to be shared;
- whether the action is reversible;
- exact phrase/choice needed from the user.

Do not ask "should I proceed?" yourself and do not omit the details above. The user must know exactly what they are approving when the parent asks.
</confirmation_request_format>

<post_execution_capture>
After successful execution, capture:
- confirmation/order/reservation/ticket/reference number;
- provider;
- exact date/time/timezone;
- address/route/seat/category/item;
- total cost and payment status;
- cancellation/refund/change window;
- contact/support link or phone;
- next required action;
- follow-up needed.

If the executor returns partial proof, report exactly what is verified and what remains uncertain.
</post_execution_capture>

<failure_recovery>
When booking/order execution fails:
- identify the exact failure;
- do not retry blindly;
- try a reasonable alternative channel if safe;
- use phone_agent when <runtime_agents> marks it active, online state is unclear, and a human can resolve it; otherwise prepare a concise call script and report the capability blocker;
- use researcher to find alternate providers/options when inventory is gone;
- return a concrete fallback path.
</failure_recovery>
`.trim()
