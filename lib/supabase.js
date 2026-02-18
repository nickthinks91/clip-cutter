import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export async function getSongs() {
  const { data } = await supabase.from("songs").select("*").order("created_at", { ascending: false });
  return data || [];
}

export async function createSong({ name, duration, bpm, shareLink, audioPath }) {
  const { data } = await supabase.from("songs").insert({ name, duration, bpm, share_link: shareLink || "", audio_path: audioPath || "" }).select().single();
  return data;
}

export async function updateSong(id, updates) {
  await supabase.from("songs").update(updates).eq("id", id);
}

export async function deleteSong(id) {
  const { data: song } = await supabase.from("songs").select("audio_path").eq("id", id).single();
  if (song?.audio_path) await supabase.storage.from("songs").remove([song.audio_path]);
  await supabase.from("songs").delete().eq("id", id);
}

export async function uploadAudio(file, songId) {
  const ext = file.name.split(".").pop();
  const path = `${songId}.${ext}`;
  await supabase.storage.from("songs").upload(path, file, { cacheControl: "3600", upsert: true });
  await supabase.from("songs").update({ audio_path: path }).eq("id", songId);
  return path;
}

export function getAudioUrl(audioPath) {
  if (!audioPath) return null;
  const { data } = supabase.storage.from("songs").getPublicUrl(audioPath);
  return data?.publicUrl || null;
}

export async function saveAiClips(songId, clips) {
  const rows = clips.map(c => ({ song_id: songId, start_time: c.startTime, end_time: c.endTime, score: c.score || 0 }));
  await supabase.from("ai_clips").insert(rows);
}

export async function getAiClips(songId) {
  const { data } = await supabase.from("ai_clips").select("*").eq("song_id", songId).order("score", { ascending: false });
  return (data || []).map(r => ({ startTime: r.start_time, endTime: r.end_time, score: r.score }));
}

export async function submitPicks(songId, memberName, clips) {
  await supabase.from("submissions").upsert(
    { song_id: songId, member_name: memberName, clips, submitted_at: new Date().toISOString() },
    { onConflict: "song_id,member_name" }
  );
}

export async function getSubmissions(songId) {
  const { data } = await supabase.from("submissions").select("*").eq("song_id", songId).order("submitted_at");
  return (data || []).map(r => ({ member: r.member_name, clips: r.clips || [], submittedAt: r.submitted_at }));
}

export function subscribeToSubmissions(songId, callback) {
  const channel = supabase.channel(`subs-${songId}`).on("postgres_changes", { event: "*", schema: "public", table: "submissions", filter: `song_id=eq.${songId}` }, () => callback()).subscribe();
  return () => supabase.removeChannel(channel);
}

export default supabase;
