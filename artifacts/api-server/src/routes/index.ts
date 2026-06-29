import { Router, type IRouter } from "express";
import healthRouter from "./health";
import postsRouter from "./posts";
import sourcesRouter from "./sources";
import scheduleRouter from "./schedule";
import statsRouter from "./stats";
import settingsRouter from "./settings";
import webhookRouter from "./webhook";

const router: IRouter = Router();

router.use(healthRouter);
router.use(postsRouter);
router.use(sourcesRouter);
router.use(scheduleRouter);
router.use(statsRouter);
router.use(settingsRouter);
router.use(webhookRouter);

export default router;
