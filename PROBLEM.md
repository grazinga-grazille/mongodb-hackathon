# Problem: Refund Scams That Are Hard to Track

## The problem
Refund scammers call support with claims like "it never arrived" or "the box was empty", then change their story and open new accounts so each call looks like a different, legitimate customer. Support agents judge one call at a time, so the scam is invisible: the words change, the accounts change, and the same person gets paid again and again. Fraudulent returns and claims cost U.S. retailers an estimated $100B+ a year.

## Our solution
A voice AI refund agent that remembers each scammer's **footprint**, not just their words. Scammers can rewrite the script and switch accounts, but they can't easily change where the package goes, what card pays for it, or what the delivery records show.

**One line:** *Scammers can change their story and their account, but not their footprint.*

## What the agent remembers
| Data | Matched by | Catches |
|---|---|---|
| Claim story and policy probing | Atlas Vector Search | Reworded scripts |
| Footprint (hashed address, card token, device) | Exact or fuzzy match | Different accounts, same person or ring |
| Delivery records and claim history | Order lookup | Claims that contradict the facts, serial claimers |
| Money history (refunds, open chargebacks) | Order lookup | Paying twice |
| Analyst outcomes | Attached to memories | Corrections |

## Memory rules
- **Who can read:** scripts are shared across merchants with no personal data; footprints are hashed and private to each merchant.
- **How long it lives:** scripts 90 days and footprint links 180 days, extended when seen again (TTL index).
- **Corrected:** an analyst clears an honest customer and the link is removed.
- **Forgotten:** "forget me" deletes memories; legal order and refund records stay.

## Demo
1. **Jake:** "never arrived" while the carrier shows delivered with a photo, and it's his 2nd claim. Escalated.
2. **Maria**, a new account: "empty box", a different story but the same address and card as Jake. Linked and escalated.
3. **Priya:** "never arrived" with no scan, first claim, no links. Instant refund.
4. **Jake** calls back while a chargeback is open. No payout through either route.

**Out of scope:** voice biometrics, emotion as a fraud signal, real payments (simulated).
