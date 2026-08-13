-- ============================================================================
-- MILK POP — T13.3.3 LAUNCH CONTENT HONESTY
--
-- A fresh small-business deployment must not publish unreviewed prices,
-- promotions or dated announcements, and must not present generic SOP/training
-- fixtures to staff as approved operating instructions. The corrected
-- production seed starts those surfaces unpublished/empty. This append-only
-- migration brings pre-launch databases created from the earlier seed to the
-- same posture without touching a commissioned store.
-- ============================================================================

-- Replace the old supplier-specific statement only while it is unchanged.
update site_settings
   set allergen_notice = 'Allergen notice: Ingredients and allergen information vary by product and supplier. If you have any food allergy or intolerance, please ask a trained team member before ordering. Cross-contact may be possible.'
 where id = 1
   and allergen_notice = 'Allergen Notice: Our dairy, custard ingredients, and specialized toppings are handled in environments processing peanuts, pistachios, hazelnuts, gluten-based cookies, and eggs. If you possess severe food intolerances, please ask a Store Barista for targeted batch disclosures.';

-- Only neutralise starter publication state when no store has been activated.
-- Once a real kiosk is ACTIVE, owner publication decisions are left untouched.
update menu_items
   set available = false
 where id in ('m1','m2','m3','m4','m5','m6','m7','m8','m9','m10',
              'sm1','sm2','sm3','sm4','ss1','ss2','ss3','sl1','sl2',
              'e1','e2','e3','e4','e5')
   and not exists (select 1 from stores where setup_status = 'ACTIVE');

update deals
   set active = false
 where id in ('deal_two_shakes','deal_third_free')
   and not exists (select 1 from stores where setup_status = 'ACTIVE');

update news_posts
   set status = 'draft'
 where id = 'news_welcome_1'
   and title = 'Welcome to Milk Pop'
   and not exists (select 1 from stores where setup_status = 'ACTIVE');

update cms_pages
   set status = 'draft'
 where id = 'cms_home'
   and last_edited_by = 'System'
   and not exists (select 1 from stores where setup_status = 'ACTIVE');

-- Remove only the exact historical starter checklist rows, and only where no
-- checklist activity exists. Matching the full seeded tuple protects an owner
-- who edited a starter row before commissioning: owner-authored content is not
-- silently deleted merely because it retained the historical ID.
delete from checklist_templates c
 using (values
   ('ck_o1','Confirm walk-in chillers are between 1°C and 4°C and log the reading','opening',true,1),
   ('ck_o2','De-ice blend nozzles and sanitise stainless prep counters','opening',true,2),
   ('ck_o3','Stock paper straws, lids and takeaway collars at the pass','opening',false,3),
   ('ck_o4','Calibrate caramel syrup pumps (one squeeze = 15ml)','opening',false,4),
   ('ck_o5','Count the float and sign the till on','opening',true,5),
   ('ck_m1','Mid-day temperature check on all display fridges','midday',true,1),
   ('ck_m2','Wipe seating zones and restock napkin stations','midday',false,2),
   ('ck_m3','Rotate milk stock — check dates, FIFO order','midday',true,3),
   ('ck_m4','Empty and re-line front-of-house bins','midday',false,4),
   ('ck_c1','Strip, wash and sanitise shake churns and blender canisters','closing',true,1),
   ('ck_c2','Cash up the till and reconcile card terminal totals','closing',true,2),
   ('ck_c3','Record closing fridge temperatures in the log','closing',true,3),
   ('ck_c4','Mop floors, switch off signage and set the alarm','closing',false,4)
 ) as seeded(id,label,category,critical,sort_order)
 where c.id = seeded.id
   and c.label = seeded.label
   and c.category = seeded.category
   and c.critical = seeded.critical
   and c.sort_order = seeded.sort_order
   and not exists (
     select 1 from app_state a
      where a.key like 'milkpop_checklist_tasks:%'
         or a.key like 'milkpop_checklist_audits:%'
   )
   and not exists (select 1 from stores where setup_status = 'ACTIVE');

-- Remove the exact Academy starter records only where nobody has used them.
-- Full content fingerprints ensure an owner-edited course or assessment is
-- preserved even before the first store becomes ACTIVE.
delete from training_courses c
 where c.id = 'c1'
   and c.title = 'Module 1: Welcome to Milk Pop'
   and c.description = 'It introduces every new team member to the heart of Milk Pop: our purpose, our standards, our customers, our working environment, and the role each person plays in helping the brand grow.'
   and c.category = 'induction'
   and c.progress = 0
   and c.points = 150
   and c.estimated_time = '35–45 mins'
   and c.badge = 'Ambassador Badge'
   and c.assessment_id = 'a1'
   and not exists (select 1 from training_progress p where p.course_id = c.id)
   and not exists (select 1 from training_results r where r.course_id = c.id)
   and not exists (select 1 from stores where setup_status = 'ACTIVE');

delete from training_assessments a
 where a.id = 'a1'
   and a.title = 'Welcome to Milk Pop — Knowledge Check'
   and a.description = 'Confirms the essentials from Module 1 before the first solo shift.'
   and a.learning_objectives = '["Know the Milk Pop brand promise","Know the fridge temperature limits","Know the allergen escalation steps"]'::jsonb
   and a.passing_score = 80
   and a.slides = '[]'::jsonb
   and a.questions = '[{"id":"q1","text":"What temperature band must walk-in chillers stay inside?","type":"multiple_choice","options":["1°C – 4°C","5°C – 8°C","-2°C – 0°C","Any, if logged"],"correctAnswer":"1°C – 4°C","explanation":"Dairy safety requires 1–4°C, logged twice per shift.","difficulty":"easy","categoryTag":"safety"}]'::jsonb
   and a.category = 'brand'
   and a.points = 150
   and a.badge = 'Ambassador Badge'
   and not exists (select 1 from training_assignments x where x.assessment_id = a.id)
   and not exists (select 1 from training_certificates x where x.assessment_id = a.id)
   and not exists (select 1 from training_results x where x.assessment_id = a.id)
   and not exists (select 1 from stores where setup_status = 'ACTIVE');

-- Remove only exact KB starter rows. Pair each historical ID with its full
-- original content so owner edits are never mistaken for demo content.
delete from kb_articles k
 where not exists (select 1 from stores where setup_status = 'ACTIVE')
   and (
     (k.id = 'k1'
      and k.title = 'Opening Station Verification Procedures'
      and k.category = 'opening'
      and k.last_updated = '15 May 2026'
      and k.author = ''
      and k.reading_time = '6 mins'
      and k.content = 'All raw storage nodes must be logged. Proper startup of high-speed shake churns ensures creamy foam profiles. Check milk delivery dates immediately upon receipt.'
      and k.steps = '["Log into the temperature monitoring terminal. Confirm walk-in chillers are strictly between 1°C and 4°C.","De-ice core blend nozzles using distilled hot water. Wipe stainless steel prep counters with approved sanitiser.","Arrange biodegradable paper straws, customized lids, and premium takeaway collars in chronological dispenser queues.","Calibrate caramel syrup pumps: verify a single squeeze dispenses exactly 15ml."]'::jsonb)
     or
     (k.id = 'k2'
      and k.title = 'Strict Allergen Cross-Contact Policies'
      and k.category = 'recipes'
      and k.last_updated = '12 Jan 2026'
      and k.author = ''
      and k.reading_time = '5 mins'
      and k.content = 'Pistachios and dairy are dominant elements. When an allergen request triggers, dedicated orange-rimmed blender cups must be sourced and washed separately.'
      and k.steps = '["Wipe the primary station down completely while donning fresh secondary disposable gloves.","Retrieve the dedicated clean blender canister designated for allergy preps.","Gather fresh garnishes from sealed isolation chambers to avoid main bowl exposure.","Label the finished premium container clearly with allergen warnings."]'::jsonb)
   );

-- The migration changes whole-collection snapshots outside the regular editor
-- RPCs. Advance the matching revisions so an already-open Admin tab cannot
-- overwrite the new state using its pre-migration snapshot.
update collection_revisions
   set revision = revision + 1, updated_at = now()
 where table_key in ('menu_items','deals','news_posts','checklist_templates',
                     'training_courses','training_assessments','kb_articles')
   and not exists (select 1 from stores where setup_status = 'ACTIVE');
