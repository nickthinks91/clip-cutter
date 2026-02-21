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

// ═══ VIRAL INTELLIGENCE ═══

// Search for matching viral sounds by song name/artist
export async function findViralMatch(songName) {
  // Clean the filename: remove extension, featured artists markers, etc.
  const clean = songName.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ').trim();
  const words = clean.split(/\s+/).filter(w => w.length > 2);
  
  // Try progressively broader searches
  // First: exact-ish match on title
  const { data: exact } = await supabase
    .from('viral_sounds')
    .select('*')
    .ilike('title', `%${clean}%`)
    .order('usage_count', { ascending: false })
    .limit(5);
  if (exact?.length) return { matches: exact, matchType: 'exact' };

  // Second: search by individual significant words
  for (const word of words) {
    if (['the', 'and', 'for', 'feat', 'with', 'mix', 'remix', 'version', 'audio', 'official'].includes(word.toLowerCase())) continue;
    const { data } = await supabase
      .from('viral_sounds')
      .select('*')
      .ilike('title', `%${word}%`)
      .order('usage_count', { ascending: false })
      .limit(10);
    if (data?.length > 0) return { matches: data, matchType: 'partial', keyword: word };
  }

  return { matches: [], matchType: 'none' };
}

// Get viral patterns for a genre
export async function getViralPatterns(genre) {
  const { data } = await supabase
    .from('viral_patterns')
    .select('*')
    .eq('genre', genre);
  if (!data?.length) return null;
  const patterns = {};
  data.forEach(p => { patterns[p.pattern_type] = p.pattern_data; });
  return patterns;
}

// Get top viral sounds for a genre (for display)
export async function getTopViralSounds(genre, limit = 20) {
  const { data } = await supabase
    .from('viral_sounds')
    .select('title, artist, usage_count, sound_duration, sub_genre, genre')
    .eq('genre', genre)
    .order('usage_count', { ascending: false })
    .limit(limit);
  return data || [];
}

// Get all genres with sound counts
export async function getViralStats() {
  const genres = ['country', 'hiphop', 'pop', 'edm', 'rnb', 'rock', 'indie', 'latin'];
  const stats = {};
  for (const g of genres) {
    const { count } = await supabase.from('viral_sounds').select('*', { count: 'exact', head: true }).eq('genre', g);
    stats[g] = count || 0;
  }
  return stats;
}

export default supabase;
