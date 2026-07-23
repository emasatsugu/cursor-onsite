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
import { browserSubs, runningLoops, vmByThread, vmSockets } from "../memory/state.js";
import {
  createTranscriptWithUserPrompt,
  findHealthyUnassignedVm,
  runAgentLoop,
} from "../agent/loop.js";
import { sendAssignment } from "../ws/vm.js";
import { cpLog } from "../debug/log.js";

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
   * Debug: in-memory VM pool + DB assignments + browser subscriptions.
   * GET /debug/state
   */
  router.get("/debug/state", async (_req: Request, res: Response) => {
    try {
      const dbVms = await VirtualMachine.findAll({ order: [["createdAt", "ASC"]] });
      const assignments = await Assignment.findAll({
        order: [["createdAt", "ASC"]],
      });

      const assignedVmIds = new Set(
        assignments.filter((a) => a.status === "active").map((a) => a.vmId)
      );

      const pool = dbVms.map((vm) => {
        const connected = vmSockets.has(vm.externalId);
        const assigned = assignedVmIds.has(vm.id);
        const threadIds = [...vmByThread.entries()]
          .filter(([, ext]) => ext === vm.externalId)
          .map(([threadId]) => threadId);
        return {
          id: vm.id,
          externalId: vm.externalId,
          status: vm.status,
          connected,
          assigned,
          threadIds,
          availableForNewThread: connected && vm.status === "healthy" && !assigned,
        };
      });

      const assignmentRows = await Promise.all(
        assignments.map(async (a) => {
          const vm = dbVms.find((v) => v.id === a.vmId);
          return {
            id: a.id,
            threadId: a.threadId,
            vmId: a.vmId,
            vmExternalId: vm?.externalId ?? null,
            status: a.status,
            createdAt: a.createdAt.toISOString(),
            loopRunning: runningLoops.has(a.threadId),
            browserSubscribers: browserSubs.get(a.threadId)?.size ?? 0,
          };
        })
      );

      const connectedExternalIds = [...vmSockets.keys()];
      const orphanSockets = connectedExternalIds.filter(
        (ext) => !dbVms.some((v) => v.externalId === ext)
      );

      res.json({
        pool,
        assignments: assignmentRows,
        inMemory: {
          connectedExternalIds,
          orphanSockets,
          vmByThread: Object.fromEntries(vmByThread),
          runningLoops: [...runningLoops],
          browserSubs: Object.fromEntries(
            [...browserSubs.entries()].map(([threadId, set]) => [threadId, set.size])
          ),
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load debug state" });
    }
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
      cpLog(
        `new assignment thread=${thread.id} → VM ${vm.externalId} (${vm.id})`
      );
      sendAssignment(vm.externalId, thread.id);

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
      cpLog(
        `follow-up on sticky assignment thread=${threadId} → VM ${vm.externalId}`
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
