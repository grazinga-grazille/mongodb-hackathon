// Append-only audit trail. Only ids and outcomes, never claim text, addresses or card data.
export function audit(db, action, details = {}) {
  return db.collection("audit_log").insertOne({ action, ...details, at: new Date() });
}
