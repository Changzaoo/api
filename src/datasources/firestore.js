// ============================================================
//  Adapter Firestore (firebase-admin)
// ------------------------------------------------------------
//  Interface comum da Data API: list/get/create/replace/update/
//  remove sobre coleções/documentos. O router não conhece os
//  detalhes do firebase-admin — só esta interface.
// ============================================================

import { getFirebaseApp } from "./firebaseApp.js";
import { notFound, badRequest } from "../util/errors.js";

// Operadores canônicos -> operadores do Firestore.
const OP_MAP = {
  eq: "==", neq: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=",
  in: "in", contains: "array-contains", containsAny: "array-contains-any",
};

function project(obj, fields) {
  const out = {};
  if (obj.id != null) out.id = obj.id;
  for (const f of fields) if (f in obj) out[f] = obj[f];
  return out;
}

export function makeFirestoreAdapter({ name, saB64 }) {
  const db = getFirebaseApp(name, saB64).firestore();

  async function list(collection, query) {
    let ref = db.collection(collection);
    for (const w of query.where) {
      const op = OP_MAP[w.op];
      if (!op) throw badRequest(`operador "${w.op}" não suportado no Firestore`);
      ref = ref.where(w.field, op, w.value);
    }
    for (const o of query.order) ref = ref.orderBy(o.field, o.dir);
    if (query.cursor) {
      const cur = await db.collection(collection).doc(query.cursor).get();
      if (cur.exists) ref = ref.startAfter(cur);
    }
    ref = ref.limit(query.limit);

    const snap = await ref.get();
    let items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (query.select) items = items.map((it) => project(it, query.select));
    const nextCursor = snap.docs.length === query.limit
      ? snap.docs[snap.docs.length - 1].id
      : null;
    return { items, nextCursor };
  }

  async function get(collection, id) {
    const snap = await db.collection(collection).doc(id).get();
    if (!snap.exists) throw notFound(`documento "${id}" não encontrado em "${collection}"`);
    return { id: snap.id, ...snap.data() };
  }

  async function create(collection, body, { id } = {}) {
    if (id) {
      await db.collection(collection).doc(id).set(body, { merge: false });
      return { id, ...body };
    }
    const ref = await db.collection(collection).add(body);
    return { id: ref.id, ...body };
  }

  async function replace(collection, id, body) {
    await db.collection(collection).doc(id).set(body, { merge: false });
    return { id, ...body };
  }

  async function update(collection, id, body) {
    const ref = db.collection(collection).doc(id);
    await ref.set(body, { merge: true });
    const snap = await ref.get();
    return { id, ...snap.data() };
  }

  async function remove(collection, id) {
    await db.collection(collection).doc(id).delete();
    return { id, deleted: true };
  }

  return { kind: "firestore", list, get, create, replace, update, remove };
}
