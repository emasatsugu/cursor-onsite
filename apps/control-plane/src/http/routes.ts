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
import {
  Assignment,
  BlobStorage,
  Thread,
  Transcript,
  VirtualMachine,
} from "../db/index.js";
import { runningLoops, vmByThread, vmSockets } from "../memory/state.js";
import {
  createTranscriptWithUserPrompt,
  findHealthyUnassignedVm,
  runAgentLoop,
} from "../agent/loop.js";
import { sendAssignment } from "../ws/vm.js";

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

      const vm = await findHealthyUnassignedVm();
      if (!vm) {
        res.status(503).json({ error: "No healthy unassigned VM available" });
        return;
      }
      if (!vmSockets.has(vm.externalId)) {
        res.status(503).json({ error: "No healthy unassigned VM available" });
        return;
      }

      const thread = await Thread.create({ userId: DEMO_USER_ID });
      await Assignment.create({
        vmId: vm.id,
        threadId: thread.id,
        status: "active",
      });
      vmByThread.set(thread.id, vm.externalId);
      sendAssignment(vm.externalId, thread.id);

      const { transcriptId, key } = await createTranscriptWithUserPrompt(
        thread.id,
        body.prompt
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

      const assignment = await Assignment.findOne({ where: { threadId } });
      if (!assignment) {
        res.status(503).json({ error: "No assignment for thread" });
        return;
      }
      const vm = await VirtualMachine.findByPk(assignment.vmId);
      if (!vm || !vmSockets.has(vm.externalId)) {
        res.status(503).json({ error: "Sticky VM not connected" });
        return;
      }
      vmByThread.set(threadId, vm.externalId);

      const { transcriptId, key } = await createTranscriptWithUserPrompt(
        threadId,
        body.prompt
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
