import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/db.js";
import { setupSocket } from "../socket.js";

test("Socket.IO: accesso autorizzato e invio negato agli estranei",async()=>{
 const original=pool.query;
 const handlers={};
 const joins=[];
 const emitted=[];
 let inserts=0;
 try {
  pool.query=async(sql,params)=>{
   if(sql.includes("SELECT 1 FROM chat_threads"))return {rows:params[2]===101||params[2]===5?[{ok:1}]:[]};
   if(sql.includes("INSERT INTO messaggi")){inserts++;return {rows:[{id:1}]}};
   if(sql.includes("SELECT driver_id FROM chat_threads"))return {rows:[{driver_id:5}]};
   throw Error("Query imprevista: "+sql);
  };
  const io={use:()=>{},on:(e,fn)=>{handlers[e]=fn},to:(room)=>({emit:(event,data)=>emitted.push({room,event,data})})};
  setupSocket(io);
  async function simulate(userId){
   const events={};
   const socket={id:"test-"+userId,user:{id:userId,role:userId===101?"cliente":"autista"},join:r=>joins.push({userId,room:r}),on:(e,fn)=>events[e]=fn};
   handlers.connection(socket);
   await events.join_chat({corsa_id:42,cliente_id:101});
   await events.send_message({corsa_id:42,cliente_id:101,text:"test",client_msg_id:"test-"+userId});
  }
  await simulate(999);
  assert.equal(inserts,0);
  assert.equal(joins.some(x=>x.userId===999&&x.room==="chat_42_101"),false);
  await simulate(101);
  assert.equal(inserts,1);
  assert.equal(joins.some(x=>x.userId===101&&x.room==="chat_42_101"),true);
  await simulate(5);
  assert.equal(inserts,2);
  assert.equal(joins.some(x=>x.userId===5&&x.room==="chat_42_101"),true);
  assert.equal(emitted.filter(x=>x.event==="new_message").every(x=>x.room==="chat_42_101"),true);
 } finally {pool.query=original;}
});
