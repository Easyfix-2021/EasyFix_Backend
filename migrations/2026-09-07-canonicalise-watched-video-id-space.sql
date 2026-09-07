-- Move stray easyfixer_watched_video rows out of the legacy id space.
--
-- WHICH COLUMN video_id REFERENCES. `training_videos.id`, always, and the
-- legacy stack says so in three independent places:
--
--   1. ACD_APIs/src/main/java/com/easyfix/website/domain/EasyfixerWatchedVideo.java:34
--      declares @JoinColumn(name = "video_id", referencedColumnName = "id").
--   2. ACD_APIs EasyfixerWatchedVideoServiceImpl:50-53 TRANSLATES before it
--      persists — the wire `videoId` is looked up with findByTrainingVideoId()
--      (WHERE training_video_id = ?) and it is the resolved row's `id` that is
--      stored, then echoed back to the client.
--   3. The measured distribution: 7,219 of 7,224 pairs carry 4 / 5 / 6, the
--      three training_videos primary keys.
--
-- So the legacy MOBILE WIRE FORMAT speaks training_video_id (1, 2, 3 — the FK
-- into `document`) while STORAGE has always spoken training_videos.id. Two id
-- spaces, one column, and a translator in between. The five bad rows are the
-- ones that reached the table without passing through that translator; MyISAM
-- parses the foreign key and ignores it, so nothing stopped them.
--
-- WHY MIGRATE THE DATA RATHER THAN RESOLVE AT READ TIME. video_id is read in
-- eight places (grade.service, mobile-registration.service, lms.service x3,
-- lms-action.service x2, mobile-profile-extra.service) plus the legacy CRM.
-- Teaching every one of them to accept two id spaces to serve five rows would
-- be permanent complexity, and any technician holding BOTH a legacy and a
-- canonical row for one video would then be counted twice. Five rows, once.
--
-- The write side is already closed: routes/mobile/profile-extra.js rejects an
-- id that is not a training_videos.id with 400 (lms.isKnownVideo), so this
-- backfill cannot be re-dirtied by the modern app, and the Flutter app still
-- posts through the legacy translator above.
--
-- THE GUARD THAT MATTERS is `NOT EXISTS (... c.id = w.video_id)` on all three
-- statements. It restricts every write to values that are NOT valid modern
-- ids. Without it, the day someone adds a video whose training_video_id
-- collides with an existing primary key, this would silently rewrite live
-- progress. Do not remove it.
--
-- MyISAM: no transaction. Statement order is the safety mechanism instead —
-- MERGE first, REMAP second. Reversed, the remap would collide with
-- uq_easyfixer_watched_video (easyfixer_id, video_id) for any technician who
-- already holds the canonical row.
--
-- trg_easyfixer_watched_video_monotonic (BEFORE UPDATE) clamps
-- watched_percentage upward. Both UPDATEs below are written so it is a no-op:
-- the merge only ever raises, the remap does not touch the column at all.
--
-- Idempotent: after it runs, no row satisfies the NOT EXISTS guard, so a
-- re-run is three no-ops.

-- 1. MERGE — the technician already has a canonical row for the same video.
--    Keep the higher progress on it; the stray is deleted in step 2.
UPDATE easyfixer_watched_video keep
  JOIN training_videos tv
    ON tv.id = keep.video_id
  JOIN easyfixer_watched_video stray
    ON stray.easyfixer_id = keep.easyfixer_id
   AND stray.video_id = tv.training_video_id
   SET keep.watched_percentage = GREATEST(
         COALESCE(keep.watched_percentage, 0),
         COALESCE(stray.watched_percentage, 0)
       )
 WHERE NOT EXISTS (SELECT 1 FROM training_videos c WHERE c.id = stray.video_id);

-- 2. DROP the merged stray, now that its progress is safe on the canonical row.
DELETE stray
  FROM easyfixer_watched_video stray
  JOIN training_videos tv
    ON tv.training_video_id = stray.video_id
  JOIN easyfixer_watched_video keep
    ON keep.easyfixer_id = stray.easyfixer_id
   AND keep.video_id = tv.id
 WHERE NOT EXISTS (SELECT 1 FROM training_videos c WHERE c.id = stray.video_id);

-- 3. REMAP the rest in place. No canonical row exists for these, so moving
--    video_id from the FK space to the PK space cannot collide.
--    This is the statement that fixes easyfixer_id 2276: its single row holds
--    video_id = 1 = training_videos.training_video_id of id 4, "Introduction
--    of Easy Fix", at 100%.
UPDATE easyfixer_watched_video stray
  JOIN training_videos tv
    ON tv.training_video_id = stray.video_id
   SET stray.video_id = tv.id
 WHERE NOT EXISTS (SELECT 1 FROM training_videos c WHERE c.id = stray.video_id);

-- Verification (read-only):
--
-- Before — the five strays, and which video each will become:
-- SELECT w.id, w.easyfixer_id, w.video_id AS legacy_id, tv.id AS canonical_id,
--        tv.title, w.watched_percentage, w.update_date
--   FROM easyfixer_watched_video w
--   JOIN training_videos tv ON tv.training_video_id = w.video_id
--  WHERE NOT EXISTS (SELECT 1 FROM training_videos c WHERE c.id = w.video_id);
--
-- After — must return zero rows (no value outside the primary-key space):
-- SELECT w.video_id, COUNT(*) n
--   FROM easyfixer_watched_video w
--  WHERE NOT EXISTS (SELECT 1 FROM training_videos c WHERE c.id = w.video_id)
--  GROUP BY w.video_id;
--
-- After — technician 2276 must read 100% against "Introduction of Easy Fix":
-- SELECT w.video_id, tv.title, w.watched_percentage
--   FROM easyfixer_watched_video w
--   JOIN training_videos tv ON tv.id = w.video_id
--  WHERE w.easyfixer_id = 2276;
--
-- After — uniqueness still holds:
-- SELECT easyfixer_id, video_id, COUNT(*) n
--   FROM easyfixer_watched_video
--  GROUP BY easyfixer_id, video_id HAVING n > 1 LIMIT 1;
