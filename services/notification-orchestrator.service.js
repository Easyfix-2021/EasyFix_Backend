const logger = require('../logger');
const inbox = require('./notification-inbox.service');
const smsService = require('./sms.service');
const emailService = require('./email.service');
const whatsappService = require('./whatsapp.service');
const fcmService = require('./fcm.service');

/*
 * Notification orchestrator: maps job-lifecycle events to (channel, recipient, template) fan-out.
 * Fire-and-forget with internal error swallowing — never blocks the caller.
 *
 * Event → channels map (extend as product team defines more):
 *   TechAssigned        → Tech: FCM + WhatsApp.  Customer: SMS.
 *   TechStart           → Customer: SMS ETA.      Tech: FCM ack.
 *   TechVisitComplete   → Customer: SMS + WhatsApp feedback. Inbox entry for PM.
 *   CancelJob           → Customer: SMS. PM inbox.
 *   RescheduleTech      → Customer: SMS/WhatsApp. PM inbox.
 */

async function onJobEvent(eventName, jobCtx) {
  // jobCtx expected: { job_id, customer_mob_no, easyfixer_name, job_owner, job_type, ...}
  try {
    switch (eventName) {
      case 'TechAssigned':
        if (jobCtx.customer_mob_no) {
          smsService.send({ to: jobCtx.customer_mob_no, message: `EasyFix: Technician ${jobCtx.easyfixer_name} assigned to your ${jobCtx.job_type} request.` });
        }
        if (jobCtx.job_owner) {
          await inbox.create({ userId: jobCtx.job_owner, jobId: jobCtx.job_id,
            title: 'Technician assigned', desc: `${jobCtx.easyfixer_name} accepted job ${jobCtx.job_id}` });
        }
        break;
      case 'TechStart':
        if (jobCtx.customer_mob_no) {
          smsService.send({ to: jobCtx.customer_mob_no, message: `EasyFix: ${jobCtx.easyfixer_name} is on the way for your ${jobCtx.job_type} appointment.` });
        }
        break;
      case 'TechVisitComplete':
        if (jobCtx.customer_mob_no) {
          smsService.send({ to: jobCtx.customer_mob_no, message: `EasyFix: Your ${jobCtx.job_type} is complete. Please rate your experience.` });
        }
        if (jobCtx.job_owner) {
          await inbox.create({ userId: jobCtx.job_owner, jobId: jobCtx.job_id,
            title: 'Job completed', desc: `Job ${jobCtx.job_id} marked complete by ${jobCtx.easyfixer_name}` });
        }
        break;
      case 'CancelJob':
        if (jobCtx.customer_mob_no) {
          smsService.send({ to: jobCtx.customer_mob_no, message: `EasyFix: Your ${jobCtx.job_type} request has been cancelled.` });
        }
        if (jobCtx.job_owner) {
          await inbox.create({ userId: jobCtx.job_owner, jobId: jobCtx.job_id,
            title: 'Job cancelled', desc: `Job ${jobCtx.job_id} cancelled.` });
        }
        break;
      case 'RescheduleTech':
        if (jobCtx.customer_mob_no) {
          smsService.send({ to: jobCtx.customer_mob_no, message: `EasyFix: Your ${jobCtx.job_type} has been rescheduled.` });
        }
        break;
      default:
        logger.debug({ eventName }, 'orchestrator: no mapping for event');
    }
  } catch (err) {
    logger.warn({ eventName, jobId: jobCtx.job_id, err: err.message }, 'notification orchestrator error');
  }
}

module.exports = { onJobEvent };
