import { Router, type Request, type Response } from "express";
import type {
  CreateThreadRequest,
  CreateThreadResponse,
  PostMessageRequest,
  PostMessageResponse,
  ThreadDetail,
  ThreadSummary,
  TranscriptBlob,
  TranscriptDTO,
} from "@poc/shared";
import { BlobStorage, Thread, Transcript } from "../db/index.js";
import {
  assignVmToThread,
  findAvailableVm,
  runningLoops,
} from "../memory/state.js";
import {
  createTranscriptWithUserPrompt,
  runAgentLoop,
} from "../agent/loop.js";
import { sendAssignment } from "../ws/vm.js";
import { ensureConnectedVmForThread } from "../assignment/lifecycle.js";
import { cpLog } from "../debug/log.js";
import { buildDebugSnapshot } from "../debug/snapshot.js";
const DEMO_USER_ID = process.env.DEMO_USER_ID ?? "demo-user";

function threadSummary(t: Thread): ThreadSummary {
  return {
    id: t.id,
    userId: t.userId,
    createdAt: t.createdAt.toISOString(),
  };
}

export function createHttpRouter(): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  /**
   * Debug: VM pool, sticky assignments, browser WS subscriptions / idle reclaim.
   * GET /debug  or  GET /debug/state
   */
  const debugHandler = (_req: Request, res: Response) => {
    res.json(buildDebugSnapshot());
  };
  router.get("/debug", debugHandler);
  router.get("/debug/state", debugHandler);

  router.get("/threads", async (_req: Request, res: Response) => {
    try {
      const threads = await Thread.findAll({
        where: { userId: DEMO_USER_ID },
        order: [["createdAt", "DESC"]],
      });
      res.json({ threads: threads.map(threadSummary) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to list threads" });
    }
  });

  router.get("/threads/:id", async (req: Request, res: Response) => {
    try {
      const thread = await Thread.findByPk(req.params.id);
      if (!thread) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }
      const transcripts = await Transcript.findAll({
        where: { threadId: thread.id },
        order: [["createdAt", "ASC"]],
      });
      const dtos: TranscriptDTO[] = [];
      for (const tr of transcripts) {
        const blob = await BlobStorage.findByPk(tr.key);
        const messages: TranscriptBlob = blob
          ? (JSON.parse(blob.value) as TranscriptBlob)
          : [];
        dtos.push({
          id: tr.id,
          threadId: tr.threadId,
          createdAt: tr.createdAt.toISOString(),
          messages,
        });
      }
      const detail: ThreadDetail = {
        ...threadSummary(thread),
        transcripts: dtos,
      };
      res.json(detail);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load thread" });
    }
  });

  router.post("/threads", async (req: Request, res: Response) => {
    try {
      const body = req.body as CreateThreadRequest;
      if (!body?.prompt || typeof body.prompt !== "string") {
        res.status(400).json({ error: "prompt is required" });
        return;
      }

      const externalId = findAvailableVm();
      if (!externalId) {
        res.status(503).json({ error: "No healthy unassigned VM available" });
        return;
      }

      const thread = await Thread.create({ userId: DEMO_USER_ID });
      assignVmToThread(thread.id, externalId);
      cpLog(`new assignment thread=${thread.id} → VM ${externalId}`);
      sendAssignment(externalId, thread.id);

      const { transcriptId, key } = await createTranscriptWithUserPrompt(
        thread.id,
        body.prompt
      );
      cpLog(
        `POST /threads promptLen=${body.prompt.length} thread=${thread.id} transcript=${transcriptId}`
      );

      if (runningLoops.has(thread.id)) {
        res.status(409).json({ error: "Generation already running" });
        return;
      }
      runningLoops.add(thread.id);
      void runAgentLoop(thread.id, transcriptId, key);

      const response: CreateThreadResponse = { thread: threadSummary(thread) };
      res.status(201).json(response);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to create thread" });
    }
  });

  router.post("/threads/:id/messages", async (req: Request, res: Response) => {
    try {
      const threadId = req.params.id;
      const body = req.body as PostMessageRequest;
      if (!body?.prompt || typeof body.prompt !== "string") {
        res.status(400).json({ error: "prompt is required" });
        return;
      }

      const thread = await Thread.findByPk(threadId);
      if (!thread) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }

      if (runningLoops.has(threadId)) {
        res.status(409).json({ error: "Generation already running for this thread" });
        return;
      }

      const ensured = await ensureConnectedVmForThread(threadId);
      if (!ensured) {
        res.status(503).json({
          error:
            "No connected VM for thread (and no free VM to assign)",
        });
        return;
      }
      cpLog(
        `follow-up thread=${threadId} → VM ${ensured.externalId}` +
          (ensured.reassigned ? " (reassigned)" : "")
      );

      const { transcriptId, key } = await createTranscriptWithUserPrompt(
        threadId,
        body.prompt
      );
      cpLog(
        `POST /threads/${threadId}/messages promptLen=${body.prompt.length} transcript=${transcriptId}`
      );

      runningLoops.add(threadId);
      void runAgentLoop(threadId, transcriptId, key);

      const response: PostMessageResponse = { transcriptId };
      res.status(200).json(response);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to post message" });
    }
  });

  return router;
}
