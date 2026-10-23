import {randomUUID} from 'node:crypto';
export function createApproval(store,action,context,ttl=900000){
  const row={...action,id:randomUUID(),created:new Date().toISOString(),expires:Date.now()+ttl};
  store.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?)').run(row.id,JSON.stringify(row),'pending',row.expires,context);
  store.audit('approval.requested',{id:row.id,type:row.type,target:row.target});return row;
}
export function claimApproval(store,id,context,confirmation){
  const row=store.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
  if(!row)throw new Error('Approval not found.');
  const action=JSON.parse(row.body);
  if(row.status!=='pending')throw new Error('This request was already processed.');
  if(row.expires<Date.now())throw new Error('Approval expired. Prepare a new proposal.');
  if(row.context!==context)throw new Error('Connection or account changed. Prepare a new proposal.');
  if(confirmation!==action.target)throw new Error('Enter the exact service name to approve.');
  const result=store.db.prepare("UPDATE approvals SET status='executing' WHERE id=? AND status='pending'").run(id);
  if(result.changes!==1)throw new Error('Another action is running.');
  store.audit('approval.accepted',{id,type:action.type,target:action.target});return action;
}
