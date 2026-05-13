import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";

export async function POST(req) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
  const { song_id, cluster_key, notes } = await req.json();

  if (!song_id || !cluster_key || !Array.isArray(notes)) {
    return Response.json({ error: "Missing required fields" }, { status: 400 });
  }

  const sortedNotes = [...notes].sort((a, b) =>
    a.member_name.localeCompare(b.member_name) || a.note_text.localeCompare(b.note_text)
  );
  const notes_hash = crypto.createHash("sha256").update(JSON.stringify(sortedNotes)).digest("hex");

  const { data: cached } = await supabase
    .from("note_summaries")
    .select("*")
    .eq("song_id", song_id)
    .eq("cluster_key", cluster_key)
    .single();

  if (cached && cached.notes_hash === notes_hash) {
    return Response.json({ summary_text: cached.summary_text, member_names: cached.member_names, note_count: cached.note_count, cached: true });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let summary_text;
  try {
    const notesText = notes.map(n => `${n.member_name}: ${n.note_text}`).join("\n");
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      system: "Write a 1-2 sentence summary of the following clip notes from team members. When opinions diverge, attribute them by member name. Use plain prose with no markdown.",
      messages: [{ role: "user", content: notesText }],
    });
    summary_text = msg.content[0].text;
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }

  const member_names = [...new Set(notes.map(n => n.member_name))];
  const note_count = notes.length;

  await supabase.from("note_summaries").upsert(
    { song_id, cluster_key, notes_hash, summary_text, member_names, note_count, updated_at: new Date().toISOString() },
    { onConflict: "song_id,cluster_key" }
  );

  return Response.json({ summary_text, member_names, note_count, cached: false });
}
