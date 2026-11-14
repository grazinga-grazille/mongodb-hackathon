# Voice Script: Why Vector Search

> Say this after the second caller is sent to a specialist. Each bullet is one breath.

---

## The problem: scammers reuse the same story

- Refund fraud isn't random. It's a business.

- Researchers at the University of Portsmouth analysed nearly half a million posts on Telegram, Discord and cybercrime forums (source below).

- They found scammers openly sharing and selling refund methods, and the most common ones are "it never arrived" and "the box was empty".

- When one method is sold to hundreds of people, the same story comes back again and again, from accounts that look completely unrelated.

---

## Why ordinary rules can't catch it

- Traditional fraud checks match exact things: the same address, the same card, the same phone number.

- We use those too, but scammers change names, addresses and cards easily.

- And they never repeat a story word for word. "It never arrived" becomes "I never received it" or "nothing showed up".

- A keyword rule sees three different complaints. It's really one story.

---

## What vector search adds

- Every caller's story is turned into an embedding: a list of numbers that captures what the story *means*, not which words it uses.

- MongoDB Atlas Vector Search then asks one question: "Have we heard a story like this before?"

- That's how the second caller was caught. Different words, same meaning, and Atlas found the match in milliseconds.

---

## Why MongoDB makes this powerful

- The embeddings live in the same database as the orders, claims and refunds. There's no separate vector database to sync.

- One query can mix meaning and rules: "find similar stories, but only from this store, and only ones that haven't expired."

- That keeps each store's data private, enforced by the database itself, not by trusting the AI.

- Every memory expires on its own after 90 days, so the agent remembers what it needs and forgets on schedule.

- And because the data streams live, the specialist sees the match the moment the call ends.

---

## The result

- Every call makes the agent sharper, because every story it hears becomes memory for the next decision.

- Honest customers are refunded in seconds.

- Suspicious claims never get an accusation. They go to a specialist, with the evidence already laid out.

- Scammers can change their name and their words, but they can't change what their story means.

---

## Source

1. University of Portsmouth, with Bristol, Surrey and QUT; funded by Cifas, the UK fraud-prevention service. Return to Sender: Mapping the Online Economy of Refund Fraud, May 2026. This is the academic anchor.

- Analysed nearly 500,000 posts on cybercrime forums, Telegram and Discord.
- Found fraudsters "openly share techniques, target retailers and sell fraudulent refunds as a paid service", with some vendors taking up to 30% of the refund.
- The standard methods it lists include claiming an order never arrived and reporting empty or partially empty boxes: exactly your demo story.
- Communities act as "knowledge-sharing networks" where users trade advice and troubleshoot failed attempts.
- Links: Cifas news release (https://www.cifas.org.uk/newsroom/portsmouth-uni-retail-refund-report-26) · University of Portsmouth release (https://www.port.ac.uk/news-events-and-blogs/news/refund-fraud-could-be-costing-uk-retailers-over-ps5-billion-a-year-new-research-finds) · full report (University of Surrey repository) (https://openresearch.surrey.ac.uk/esploro/outputs/report/Return-to-sender-Mapping-the-online/991128595302346) · summary (International Society of Economic Criminology) (https://www.economic-criminology.com/post/return-to-sender-the-hidden-economy-of-online-refund-fraud)
