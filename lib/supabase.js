import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// ═══ SONGS ═══
export async function getSongs() {
  const { data } = await supabase.from("songs").select("*").order("created_at", { ascending: false });
  return data || [];
}

export async function createSong({ name, duration, bpm, shareLink, audioPath, albumId, trackNumber }) {
  const row = { name, duration, bpm, share_link: shareLink || "", audio_path: audioPath || "" };
  if (albumId) row.album_id = albumId;
  if (trackNumber != null) row.track_number = trackNumber;
  const { data } = await supabase.from("songs").insert(row).select().single();
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

// ═══ ALBUMS ═══
export async function getAlbums() {
  const { data } = await supabase.from("albums").select("*").order("created_at", { ascending: false });
  return data || [];
}

export async function createAlbum({ name, genre }) {
  const { data } = await supabase.from("albums").insert({ name, genre: genre || null, track_count: 0 }).select().single();
  return data;
}

export async function updateAlbum(id, updates) {
  await supabase.from("albums").update(updates).eq("id", id);
}

export async function deleteAlbum(id) {
  const { data: songs } = await supabase.from("songs").select("id, audio_path").eq("album_id", id);
  if (songs?.length) {
    const paths = songs.filter(s => s.audio_path).map(s => s.audio_path);
    if (paths.length) await supabase.storage.from("songs").remove(paths);
  }
  await supabase.from("albums").delete().eq("id", id);
}

export async function getAlbumSongs(albumId) {
  const { data } = await supabase.from("songs").select("*").eq("album_id", albumId).order("track_number", { ascending: true });
  return data || [];
}

export async function getAlbumProgress(albumId, memberName) {
  const { data: songs } = await supabase.from("songs").select("id").eq("album_id", albumId);
  if (!songs?.length) return { total: 0, completed: 0, completedIds: [] };
  const songIds = songs.map(s => s.id);
  const { data: subs } = await supabase.from("submissions").select("song_id, clips").eq("member_name", memberName).in("song_id", songIds);
  const completedIds = (subs || []).filter(s => s.clips && s.clips.length > 0).map(s => s.song_id);
  return { total: songs.length, completed: completedIds.length, completedIds };
}

export async function getAlbumAllProgress(albumId) {
  const { data: songs } = await supabase.from("songs").select("id").eq("album_id", albumId);
  if (!songs?.length) return {};
  const songIds = songs.map(s => s.id);
  const { data: subs } = await supabase.from("submissions").select("song_id, member_name, clips").in("song_id", songIds);
  const progress = {};
  (subs || []).forEach(s => {
    if (!progress[s.member_name]) progress[s.member_name] = { completed: 0, total: songs.length };
    if (s.clips && s.clips.length > 0) progress[s.member_name].completed++;
  });
  return progress;
}

// ═══ AI CLIPS ═══
export async function saveAiClips(songId, clips) {
  const rows = clips.map(c => ({ song_id: songId, start_time: c.startTime, end_time: c.endTime, score: c.score || 0 }));
  await supabase.from("ai_clips").insert(rows);
}

export async function getAiClips(songId) {
  const { data } = await supabase.from("ai_clips").select("*").eq("song_id", songId).order("score", { ascending: false });
  return (data || []).map(r => ({ startTime: r.start_time, endTime: r.end_time, score: r.score }));
}

// ═══ LEADER CLIPS ═══
export async function saveLeaderClips(songId, clips) {
  await supabase.from("leader_clips").delete().eq("song_id", songId);
  if (clips.length === 0) return;
  const rows = clips.map(c => ({ song_id: songId, start_time: c.startTime, end_time: c.endTime, score: c.score || 0, is_manual: c.isManual || false, notes: c.notes || "" }));
  await supabase.from("leader_clips").insert(rows);
}

export async function getLeaderClips(songId) {
  const { data } = await supabase.from("leader_clips").select("*").eq("song_id", songId).order("start_time", { ascending: true });
  return (data || []).map(r => ({ startTime: r.start_time, endTime: r.end_time, score: r.score, isManual: r.is_manual, notes: r.notes || "" }));
}

// ═══ SUBMISSIONS ═══
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
export async function findViralMatch(songName) {
  const clean = songName.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ').trim();
  const words = clean.split(/\s+/).filter(w => w.length > 2);
  const { data: exact } = await supabase.from('viral_sounds').select('*').ilike('title', `%${clean}%`).order('usage_count', { ascending: false }).limit(5);
  if (exact?.length) return { matches: exact, matchType: 'exact' };
  for (const word of words) {
    if (['the','and','for','feat','with','mix','remix','version','audio','official'].includes(word.toLowerCase())) continue;
    const { data } = await supabase.from('viral_sounds').select('*').ilike('title', `%${word}%`).order('usage_count', { ascending: false }).limit(10);
    if (data?.length > 0) return { matches: data, matchType: 'partial', keyword: word };
  }
  return { matches: [], matchType: 'none' };
}

export async function getViralPatterns(genre) {
  const { data } = await supabase.from('viral_patterns').select('*').eq('genre', genre);
  if (!data?.length) return null;
  const patterns = {}; data.forEach(p => { patterns[p.pattern_type] = p.pattern_data; }); return patterns;
}

export async function getTopViralSounds(genre, limit = 20) {
  const { data } = await supabase.from('viral_sounds').select('title, artist, usage_count, sound_duration, sub_genre, genre').eq('genre', genre).order('usage_count', { ascending: false }).limit(limit);
  return data || [];
}

export async function getViralPositionPatterns(genre) {
  const { data } = await supabase.from('viral_patterns').select('pattern_data').eq('genre', genre).eq('pattern_type', 'clip_position_aggregate').single();
  return data?.pattern_data || null;
}

export default supabase;
