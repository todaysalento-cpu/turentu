import test from "node:test";
import assert from "node:assert/strict";
import { canAccessChat } from "../services/chat/chat-access.service.js";

test("cliente autorizzato",async()=>{
 const db={query:async(sql,ids)=>{assert.match(sql,/chat_threads/);assert.deepEqual(ids,[42,101,101]);return {rows:[{ok:1}]}}};
 assert.equal(await canAccessChat(db,42,101,101),true);
});

test("operatore NCC autorizzato",async()=>{
 const db={query:async()=>({rows:[{ok:1}]})};
 assert.equal(await canAccessChat(db,42,101,5),true);
});

test("utente estraneo rifiutato",async()=>{
 const db={query:async()=>({rows:[]})};
 assert.equal(await canAccessChat(db,42,101,999),false);
});

test("identificativi non validi rifiutati senza query",async()=>{
 const db={query:async()=>{throw Error("Query non prevista")}};
 for(const ids of [[0,101,5],[42,-1,5],[42,101,NaN],[42,101,0]]){
  assert.equal(await canAccessChat(db,...ids),false);
 }
});
