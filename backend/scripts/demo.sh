#!/usr/bin/env bash
# Plays the PROBLEM.md demo story against a running backend (npm run dev).
# Usage: npm run demo            (BASE defaults to http://localhost:3000)
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
M="x-merchant-id: shopco"
J="content-type: application/json"

post() { curl -s -X POST "$BASE$1" -H "$J" -H "${3:-$M}" -d "$2"; }
summary() { node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);
  if(r.error){console.log("   ✖ "+r.error);return}
  if(r.decision){console.log(`   → ${r.decision}  (risk ${r.riskScore}/${r.escalateAt}, ${r.claimType})`);
    for(const x of r.signals)console.log(`     • ${x.code}${x.similarity?" "+x.similarity:""}: ${x.detail}`);
    console.log("   claimId="+r.claimId)}
  else console.log("   "+JSON.stringify(r))})'; }
claim_id() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).claimId))'; }

echo "== Reset demo data"; post /admin/reset '{}' >/dev/null; echo "   ok"

echo; echo "== Call 1 — Jake: \"never arrived\" (ord_1042, \$249)"
R=$(post /tools/check-claim '{"orderId":"ord_1042","claimText":"Yeah the headphones just never turned up at my place","callerQuestions":["Can you just refund it without me sending anything back?"]}')
echo "$R" | summary; JAKE=$(echo "$R" | claim_id)

echo; echo "== Analyst confirms Jake's claim is a scam  (memory is written)"
post /tools/record-outcome "{\"claimId\":\"$JAKE\",\"outcome\":\"confirmed_scam\"}" | summary

echo; echo "== Call 2 — Maria (new account): \"empty box\" (ord_2001, \$299)"
R=$(post /tools/check-claim '{"orderId":"ord_2001","claimText":"The box showed up but there was nothing in it"}')
echo "$R" | summary

echo; echo "== Call 3 — Priya (honest): \"never arrived\" (ord_3001, \$249)"
R=$(post /tools/check-claim '{"orderId":"ord_3001","claimText":"My headphones never arrived"}')
echo "$R" | summary; PRIYA=$(echo "$R" | claim_id)
echo "   issue refund:"; post /tools/issue-refund "{\"claimId\":\"$PRIYA\"}" | summary
echo "   try to refund again (race/double-pay):"; post /tools/issue-refund "{\"claimId\":\"$PRIYA\"}" | summary

echo; echo "== Call 4 — Jake calls back while his bank has opened a chargeback"
post /admin/disputes '{"orderId":"ord_1042"}' >/dev/null
post /tools/check-claim '{"orderId":"ord_1042","claimText":"I still have not got my refund for the headphones"}' | summary

echo; echo "== Governance — GadgetBarn searches for ShopCo's memories"
curl -s -G "$BASE/admin/memories/search" -H "x-merchant-id: gadgetbarn" --data-urlencode "q=confirmed refund scam" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of JSON.parse(s))console.log(`   ${m.type.padEnd(16)} ${m.scope.level.padEnd(8)} ${m.scope.merchantId??"(shared)"}  "${m.text}"`)})'

echo; echo "== Forget Jake (memories + footprints deleted, legal records kept)"
post /tools/forget-me '{"customerId":"cus_jake"}' | summary
