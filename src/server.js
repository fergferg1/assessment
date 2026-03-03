import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { q } from "./db.js";
import { requireJWT, requireManager } from "./auth.js";
import { computeCombinedFromAnalyses } from "./compute.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

// 1) Wix exchange: Wix backend calls this with service key + member identity
app.post("/auth/wix-exchange", async (req, res) => {
  const serviceKey = req.headers["x-wix-service-key"];
  if (!serviceKey || serviceKey !== process.env.WIX_SERVICE_KEY) {
    return res.status(401).json({ error: "Invalid service key" });
  }

  const schema = z.object({
    wixMemberId: z.string().min(3),
    email: z.string().email(),
    name: z.string().min(1)
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { wixMemberId, email, name } = parsed.data;

  // invite-based: user must already exist by email
  const userRes = await q(
    `select id, org_id, role, wix_member_id
     from users
     where lower(email)=lower($1)`,
    [email]
  );

  if (!userRes.rowCount) {
    return res.status(403).json({ error: "User not invited / not registered in organisation" });
  }

  const user = userRes.rows[0];

  // attach wix_member_id (first login)
  if (!user.wix_member_id || user.wix_member_id !== wixMemberId) {
    await q("update users set wix_member_id=$1, name=$2 where id=$3", [wixMemberId, name, user.id]);
  }

  const token = jwt.sign(
    { userId: user.id, orgId: user.org_id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  );

  res.json({ token, role: user.role });
});

// 2) Create assessment (self-start)
app.post("/assessments", requireJWT, async (req, res) => {
  const schema = z.object({ roleLevel: z.enum(["FLL","MM","SL"]) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ins = await q(
    `insert into assessments (org_id, employee_user_id, role_level)
     values ($1,$2,$3)
     returning id`,
    [req.user.orgId, req.user.userId, parsed.data.roleLevel]
  );

  res.json({ assessmentId: ins.rows[0].id });
});

// 3) Manager dashboard list
app.get("/assessments", requireJWT, requireManager, async (req, res) => {
  const status = req.query.status ? String(req.query.status) : "open";

  const rows = await q(
    `select
       a.id,
       a.role_level,
       a.status,
       a.created_at,
       a.self_submitted_at,
       a.manager_submitted_at,
       u.name as employee_name,
       u.email as employee_email
     from assessments a
     join users u on u.id = a.employee_user_id
     where a.org_id = $1 and a.status = $2
     order by coalesce(a.self_submitted_at, a.created_at) desc`,
    [req.user.orgId, status]
  );

  res.json({ items: rows.rows });
});

// 4) Submit self/manager
app.post("/assessments/:id/submissions", requireJWT, async (req, res) => {
  const assessmentId = req.params.id;

  const schema = z.object({
    raterType: z.enum(["self","manager"]),
    responses: z.record(z.string(), z.number()),
    analysis: z.any(),
    themes: z.any(),
    questions: z.any()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { raterType, responses, analysis, themes, questions } = parsed.data;

  if (raterType === "manager" && req.user.role !== "manager" && req.user.role !== "admin") {
    return res.status(403).json({ error: "Only managers can submit manager ratings" });
  }

  const a = await q("select id, employee_user_id from assessments where id=$1 and org_id=$2",
    [assessmentId, req.user.orgId]
  );
  if (!a.rowCount) return res.status(404).json({ error: "Assessment not found" });

  // participants can only submit self for their own assessment
  const isOwner = a.rows[0].employee_user_id === req.user.userId;
  if (raterType === "self" && !isOwner && req.user.role !== "manager" && req.user.role !== "admin") {
    return res.status(403).json({ error: "Cannot submit self for another user" });
  }

  await q(
    `insert into submissions (org_id, assessment_id, rater_type, submitted_by_user_id, responses_json, analysis_json)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (assessment_id, rater_type)
     do update set responses_json=excluded.responses_json, analysis_json=excluded.analysis_json, submitted_at=now()`,
    [req.user.orgId, assessmentId, raterType, req.user.userId, responses, analysis]
  );

  if (raterType === "self") {
    await q("update assessments set self_submitted_at=now() where id=$1 and org_id=$2", [assessmentId, req.user.orgId]);
  } else {
    await q("update assessments set manager_submitted_at=now() where id=$1 and org_id=$2", [assessmentId, req.user.orgId]);
  }

  const subs = await q(
    `select rater_type, responses_json, analysis_json
     from submissions
     where assessment_id=$1 and org_id=$2`,
    [assessmentId, req.user.orgId]
  );

  const self = subs.rows.find(x => x.rater_type === "self");
  const mgr  = subs.rows.find(x => x.rater_type === "manager");

  if (self && mgr) {
    const combined = computeCombinedFromAnalyses({
      themes,
      questions,
      selfAnalysis: self.analysis_json,
      mgrAnalysis: mgr.analysis_json,
      selfResponses: self.responses_json,
      mgrResponses: mgr.responses_json
    });

    await q(
      `insert into combined_results (assessment_id, org_id, alignment_score, avg_theme_gap, weights_json, top_priorities_json, combined_rows_json)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (assessment_id)
       do update set alignment_score=excluded.alignment_score,
                    avg_theme_gap=excluded.avg_theme_gap,
                    weights_json=excluded.weights_json,
                    top_priorities_json=excluded.top_priorities_json,
                    combined_rows_json=excluded.combined_rows_json,
                    created_at=now()`,
      [assessmentId, req.user.orgId, combined.alignment, combined.avgAbs, combined.weights, combined.topPriorities, combined.rows]
    );

    await q("update assessments set status='complete', completed_at=now() where id=$1 and org_id=$2",
      [assessmentId, req.user.orgId]
    );
  }

  res.json({ ok: true, combinedReady: Boolean(self && mgr) });
});

// 5) Get assessment + submissions + combined
app.get("/assessments/:id", requireJWT, async (req, res) => {
  const assessmentId = req.params.id;

  const base = await q(
    `select a.*, u.name as employee_name, u.email as employee_email
     from assessments a
     join users u on u.id = a.employee_user_id
     where a.id=$1 and a.org_id=$2`,
    [assessmentId, req.user.orgId]
  );
  if (!base.rowCount) return res.status(404).json({ error: "Not found" });

  const a = base.rows[0];

  // participant can only read own; manager can read all
  const isOwner = a.employee_user_id === req.user.userId;
  if (!isOwner && req.user.role !== "manager" && req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const subs = await q(
    `select rater_type, responses_json, analysis_json, submitted_at
     from submissions
     where assessment_id=$1 and org_id=$2`,
    [assessmentId, req.user.orgId]
  );

  const combined = await q(
    `select alignment_score, avg_theme_gap, weights_json, top_priorities_json, combined_rows_json, created_at
     from combined_results where assessment_id=$1 and org_id=$2`,
    [assessmentId, req.user.orgId]
  );

  res.json({
    assessment: {
      id: a.id,
      roleLevel: a.role_level,
      status: a.status,
      employeeName: a.employee_name,
      employeeEmail: a.employee_email,
      createdAt: a.created_at,
      selfSubmittedAt: a.self_submitted_at,
      managerSubmittedAt: a.manager_submitted_at,
      completedAt: a.completed_at
    },
    submissions: subs.rows,
    combined: combined.rowCount ? combined.rows[0] : null
  });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`API running on ${port}`));
