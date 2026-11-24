
import express from 'express';

import {
  createPublicationJob,
  listPublicationJobs,
  getPublicationJob,
} from '../../services/eventi/event-image-jobs.service.js';

const router = express.Router();

function handleError(res, error) {
  console.error('[EVENT IMAGE JOBS]', error.message);

  const status = [400, 403, 404, 409].includes(error.status)
    ? error.status
    : 500;

  return res.status(status).json({
    success: false,
    error: status === 500
      ? 'Operazione non riuscita'
      : error.message,
  });
}

router.get('/', async (req, res) => {
  try {
    const jobs = await listPublicationJobs();

    res.json({
      success: true,
      jobs,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const job = await getPublicationJob(req.params.id);

    res.json({
      success: true,
      job,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      candidateIds,
      licenza,
      attribuzione,
      diritti_verificati,
    } = req.body || {};

    const result = await createPublicationJob({
      candidateIds,
      licenza,
      attribuzione,
      diritti_verificati,
      actorId: req.user?.id ?? null,
    });

    res.status(202).json({
      success: true,
      result,
    });
  } catch (error) {
    handleError(res, error);
  }
});

export default router;
