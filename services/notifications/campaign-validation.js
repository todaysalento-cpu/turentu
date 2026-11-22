import { z } from 'zod';

export const categories = ['Presentazione Turentu','Promozioni','Eventi','Privata','Condivisa','PopBus',
  'Aeroporti e transfer','Comunicazioni di servizio','Comunicazioni amministrative'];
export const interests = ['eventi','popbus','aeroporti','condivisa','fuori_sede'];
const list = z.array(z.string().trim().min(1).max(100)).max(20).optional();
export const id = z.string().regex(/^[1-9]\d{0,18}$/).refine(value => BigInt(value)<=9223372036854775807n);
export const filters = z.object({
  role: z.enum(['cliente','autista','conducente','admin']).optional(),
  newDays: z.number().int().min(1).max(365).optional(),
  booking: z.enum(['ever','popbus','no_recent']).optional(),
  activity:z.enum(['active','inactive']).optional(),
  city:list, region:list, province:list, origin:list, destination:list,
  hub:id.optional(), stop:id.optional(), directive:id.optional(),
  interests:z.array(z.enum(interests)).max(interests.length).optional(),
  radius:z.object({lat:z.number().min(-90).max(90),lng:z.number().min(-180).max(180),km:z.number().min(1).max(200)}).strict().optional(),
  consentOnly:z.boolean().optional(),
}).strict();

const url = z.string().max(900).url().refine(value => new URL(value).protocol==='https:');
const approvedExternal = url.refine(value => {
  const parsed=new URL(value);
  const origins=(process.env.NOTIFICATION_ALLOWED_ORIGINS ?? 'https://www.turentu.com').split(',').map(origin=>origin.trim());
  return !parsed.username && !parsed.password && origins.includes(parsed.origin);
}, 'Origine URL non autorizzata');
export const draft = z.object({
  name:z.string().trim().min(1).max(100),
  category:z.enum(categories),
  purpose:z.enum(['marketing','operativa']),
  title:z.string().trim().max(65),
  body:z.string().trim().max(220),
  image_url:url.nullable(),
  action:z.discriminatedUnion('kind',[
    z.object({kind:z.enum(['home','search','popbus','promotion'])}).strict(),
    z.object({kind:z.enum(['booking','ride']),value:id}).strict(),
    z.object({kind:z.literal('external'),value:approvedExternal}).strict(),
    z.object({kind:z.literal('event'),value:id}).strict(),
  ]),
  priority:z.enum(['normal','high']),
  filters,
}).strict().superRefine((value,context) => {
  if (value.purpose==='operativa' && !categories.slice(-2).includes(value.category)) {
    context.addIssue({code:'custom',path:['purpose'],message:'Categoria operativa non compatibile'});
  }
  if (value.purpose==='marketing' && value.priority==='high') {
    context.addIssue({code:'custom',path:['priority'],message:'La priorità alta è riservata alle comunicazioni operative'});
  }
});
export const preference = z.object({
  marketing:z.boolean(),
  personalization:z.boolean().default(false),
  territory:z.object({
    region:z.string().trim().max(100).optional(), province:z.string().trim().max(100).optional(),
    city:z.string().trim().max(100).optional(), origin:z.string().trim().max(100).optional(),
    destination:z.string().trim().max(100).optional(), hub:id.optional(), stop:id.optional(), directive:id.optional(),
  }).strict(),
  interests:z.array(z.enum(interests)).max(interests.length),
}).strict();
