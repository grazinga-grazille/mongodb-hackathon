# Demo Script: Refund Guard

> 🎬 = what you do. 🗣️ = what you say. 👀 = what to point at.

> You play two callers. **The order number tells the system who is calling**, so each caller says their own order.

| Caller | Order | What happens |
|---|---|---|
| **1. Alex R.** | **2058** | Box was empty → **Refunded** |
| **2. Chris B.** | **3046** | Same story, new name, more detail → **Flagged · sent to specialist** |

---

## Before you start (off stage)

🎬 Terminal 1: `cd ~/Desktop/Coding/mongodb-hackathon/backend && npm start`

🎬 Use `npm start`, not `npm run dev`: it won't restart in the middle of your demo.

🎬 Wait for "Refund agent backend on http://localhost:3000".

🎬 Terminal 2: `cd ~/Desktop/Coding/mongodb-hackathon-frontend && npm run dev`

🎬 Open http://localhost:5173 in Chrome and check the top says ● Connected.

🎬 Click Reset demo. Cases should say "No calls yet".

🎬 Put on headphones so the agent doesn't hear itself.

---

## Intro

🗣️ Refund scammers say "the box was empty", get their money, then do it again under a new name.

🗣️ Each support call is judged on its own, so the second claim looks brand new.

🗣️ Our voice agent remembers every story in MongoDB Atlas, and uses vector search to recognise it again.

---

## Caller 1: Alex

🗣️ First, I'm Alex.

🎬 Click Start call. Allow the microphone if asked.

👀 Wait for the agent to finish its greeting.

🗣️ (To the agent, exactly) "Hi, I ordered a pair of noise-cancelling headphones, order twenty fifty-eight, and when it arrived the box was empty."

👀 If the agent asks you to confirm the order, say: "Yes, that's right."

👀 The agent approves it and refunds $249.

🎬 Click End call.

👀 Point at Cases: Alex's case appears by itself, marked "Refunded".

🗣️ First claim, and the parcel weighed less than the headphones when it shipped, so an empty box is believable. Refunded in seconds.

🗣️ Behind the scenes, Alex's story was saved to MongoDB as a vector embedding.

---

## Caller 2: Chris

🗣️ Now a different customer calls. New name, new order.

🎬 Click Start call.

👀 Wait for the agent to finish its greeting.

🗣️ (To the agent, exactly) "Hey, so I ordered the noise-cancelling headphones, order thirty forty-six. I'd been waiting all week for them, but when I opened the box there was nothing inside, just packing paper."

👀 If the agent asks you to confirm the order, say: "Yes, that's right."

👀 The agent says a specialist will review the claim. No refund.

🎬 Click End call.

---

## The key moment: why Chris was caught

👀 Point at Chris's case: "Flagged · sent to specialist".

🗣️ On paper, Chris looks exactly like Alex: first claim, and the same delivery facts.

👀 Point at the side-by-side box: "Same story as another caller".

🗣️ On the left is what Chris just said. On the right is what Alex said.

🗣️ Different name, different words, a longer story, but MongoDB Atlas Vector Search matched them by meaning: over 90% the same.

👀 Point at the footer: "different name · shares address + card".

🗣️ And the address is written differently, but it's the same one, with the same card.

🗣️ So no refund. The agent didn't accuse anyone. It handed the case to a specialist with the evidence laid out.

---

## Closing line

🗣️ Scammers can change their name and their words, but not what their story means.

🗣️ Our agent remembers every story, and catches it the second time.

---

## If something goes wrong

🎬 Agent mishears the order: say it digit by digit, "two, zero, five, eight" or "three, zero, four, six".

🎬 Chris gets refunded: you said Alex's order, or didn't reset first. Click Reset demo and redo both calls.

🎬 Agent doesn't respond: click End call, check the mic icon in Chrome's address bar, and start again.

🎬 Top says Offline: the backend stopped, so run `npm start` again in Terminal 1.
