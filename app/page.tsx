'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { getSupabaseClient } from '@/lib/supabase/client'

const matches = [
  { name: 'Maya', age: 24, location: 'Toronto', color: 'coral', interests: ['Music', 'Films'] },
  { name: 'Nia', age: 27, location: 'Brooklyn', color: 'mint', interests: ['Anime', 'Games'] },
  { name: 'Zoe', age: 23, location: 'Austin', color: 'lavender', interests: ['Books', 'Art'] },
]
const interestOptions = ['Music', 'Movies', 'Anime', 'Games', 'Books', 'Art', 'Travel', 'Food']
type View = 'home' | 'age' | 'username' | 'interests' | 'matching' | 'chat'
type ChatMessage = { id: string; from: 'me' | 'them'; text: string; createdAt: string }

export default function Page() {
  const [view, setView] = useState<View>('home')
  const [username, setUsername] = useState('Luna')
  const [interests, setInterests] = useState<string[]>(['Music'])
  const [matchIndex, setMatchIndex] = useState(0)
  const [message, setMessage] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [userId, setUserId] = useState<string | null>(null)
  const [matchId, setMatchId] = useState<string | null>(null)
  const [partnerName, setPartnerName] = useState('Maya')
  const [partnerId, setPartnerId] = useState<string | null>(null)
  const [connection, setConnection] = useState('waiting for a match')
  const [isSending, setIsSending] = useState(false)
  const [partnerTyping, setPartnerTyping] = useState(false)
  const [lastReadMessageId, setLastReadMessageId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const waitChannelRef = useRef<RealtimeChannel | null>(null)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionId = useMemo(() => crypto.randomUUID(), [])
  const supabase = useMemo(() => getSupabaseClient(), [])
  const current = { ...matches[matchIndex % matches.length], name: partnerName || matches[matchIndex % matches.length].name }

  const playSound = useCallback(() => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(400, audioCtx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(800, audioCtx.currentTime + 0.1)
      gain.gain.setValueAtTime(0, audioCtx.currentTime)
      gain.gain.linearRampToValueAtTime(0.2, audioCtx.currentTime + 0.05)
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15)
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.start(audioCtx.currentTime)
      osc.stop(audioCtx.currentTime + 0.15)
    } catch (e) { /* ignore */ }
  }, [])

  useEffect(() => () => { 
    if (channelRef.current && supabase) supabase.removeChannel(channelRef.current)
    if (waitChannelRef.current && supabase) supabase.removeChannel(waitChannelRef.current)
  }, [supabase])
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [messages, partnerTyping])

  useEffect(() => {
    if (!matchId || !userId || !supabase) return

    let active = true
    const channel = supabase.channel(`match:${matchId}`, { config: { private: true } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tomble_messages', filter: `match_id=eq.${matchId}` }, (payload) => {
        if (!active) return
        const row = payload.new as any
        if (row.sender_id === userId) return
        const messageText = row.body || row.content || row.text || row.message || ''
        setMessages((items) => items.some((item) => item.id === row.id) ? items : [...items, { id: row.id, from: 'them', text: messageText, createdAt: row.created_at }])
        setPartnerTyping(false)
        playSound()
        setTimeout(() => { if (active && channelRef.current) channelRef.current.send({ type: 'broadcast', event: 'read', payload: { sender_id: userId, message_id: row.id } }) }, 500)
      })
      .on('broadcast', { event: 'typing' }, (payload) => {
        if (!active) return
        if (payload.payload.sender_id !== userId) setPartnerTyping(payload.payload.isTyping)
      })
      .on('broadcast', { event: 'read' }, (payload) => {
        if (!active) return
        if (payload.payload.sender_id !== userId) setLastReadMessageId(payload.payload.message_id)
      })
      .subscribe((status) => {
        console.log('Chat channel status:', status)
        if (status === 'CHANNEL_ERROR') console.error('Chat channel error')
        if (status === 'TIMED_OUT') console.error('Chat channel timed out')
        if (active) setConnection(status === 'SUBSCRIBED' ? 'connected' : status.toLowerCase())
      })

    channelRef.current = channel

    return () => {
      active = false
      supabase.removeChannel(channel)
      channelRef.current = null
    }
  }, [matchId, userId, supabase, playSound])

  const start = () => setView('age')
  const toggleInterest = (interest: string) => setInterests((items) => items.includes(interest) ? items.filter((item) => item !== interest) : [...items, interest])

  const loadMatch = async (id: string, nextMatchId: string) => {
    if (!supabase) return
    setMatchId(nextMatchId)
    const { data } = await supabase.from('tomble_messages').select('*').eq('match_id', nextMatchId).order('created_at', { ascending: true })
    setMessages((data ?? []).map((row: any) => ({ id: row.id, from: row.sender_id === id ? 'me' : 'them', text: row.body || row.content || row.text || row.message || '', createdAt: row.created_at })))
    setView('chat')
  }

  const createAnonymousSession = async () => {
    if (!supabase) return null
    const { data, error } = await supabase.auth.getSession()
    if (error) return null
    if (data.session?.user) { setUserId(data.session.user.id); return data.session.user.id }
    const created = await supabase.auth.signInAnonymously()
    if (created.error || !created.data.user) return null
    setUserId(created.data.user.id)
    return created.data.user.id
  }

  const beginMatching = async () => {
    const id = userId ?? await createAnonymousSession()
    setView('matching')
    if (!id || !supabase) return
    
    if (waitChannelRef.current) supabase.removeChannel(waitChannelRef.current)
    waitChannelRef.current = supabase.channel(`tomble-wait-${id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tomble_matches' }, async (payload) => {
        const row = payload.new as any;
        if (row.user1_id === id || row.user2_id === id) {
           const { data } = await supabase.rpc('tomble_find_match', { p_user_id: id, p_nickname: username.trim() || 'Luna', p_interests: interests, p_is_adult: true })
           const found = data?.[0]
           if (found) { 
             setPartnerId(found.partner_id); 
             setPartnerName(found.partner_nickname || 'Maya'); 
             await loadMatch(id, found.match_id);
             if (waitChannelRef.current) supabase.removeChannel(waitChannelRef.current);
           }
        }
      })
      .subscribe()

    const { data, error } = await supabase.rpc('tomble_find_match', { p_user_id: id, p_nickname: username.trim() || 'Luna', p_interests: interests, p_is_adult: true })
    if (error) { setConnection('ready when you are'); return }
    const found = data?.[0]
    if (found) { 
      setPartnerId(found.partner_id); 
      setPartnerName(found.partner_nickname || 'Maya'); 
      await loadMatch(id, found.match_id) 
      if (waitChannelRef.current) supabase.removeChannel(waitChannelRef.current)
    }
    else setConnection('waiting for another Tomble')
  }

  const send = async () => {
    const clean = message.trim()
    if (!clean || clean.length > 500 || !userId || !matchId || !supabase || isSending) return
    setIsSending(true)
    
    let result = await supabase.from('tomble_messages').insert({ match_id: matchId, sender_id: userId, body: clean }).select('*').single()
    if (result.error && result.error.message.includes('body')) result = await supabase.from('tomble_messages').insert({ match_id: matchId, sender_id: userId, content: clean }).select('*').single()
    if (result.error && result.error.message.includes('content')) result = await supabase.from('tomble_messages').insert({ match_id: matchId, sender_id: userId, text: clean }).select('*').single()
    if (result.error && result.error.message.includes('text')) result = await supabase.from('tomble_messages').insert({ match_id: matchId, sender_id: userId, message: clean }).select('*').single()

    if (result.error) {
      alert("Failed to send: " + result.error.message)
      console.error("Message send error:", result.error)
    } else if (result.data) {
      const row = result.data as any
      const messageText = row.body || row.content || row.text || row.message || clean
      setMessages((items) => items.some((item) => item.id === row.id) ? items : [...items, { id: row.id, from: 'me', text: messageText, createdAt: row.created_at }])
      setMessage('')
    }
    setIsSending(false)
  }

  const handleTyping = (text: string) => {
    setMessage(text)
    if (!channelRef.current || !userId) return
    channelRef.current.send({ type: 'broadcast', event: 'typing', payload: { sender_id: userId, isTyping: text.length > 0 } })
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
    if (text.length > 0) {
      typingTimeoutRef.current = setTimeout(() => {
        if (channelRef.current && userId) channelRef.current.send({ type: 'broadcast', event: 'typing', payload: { sender_id: userId, isTyping: false } })
      }, 2000)
    }
  }

  const nextTomble = async () => {
    if (supabase && matchId) await supabase.rpc('tomble_end_match', { p_match_id: matchId })
    if (channelRef.current && supabase) supabase.removeChannel(channelRef.current)
    if (waitChannelRef.current && supabase) supabase.removeChannel(waitChannelRef.current)
    setMatchIndex((index) => index + 1); setMatchId(null); setPartnerId(null); setMessages([]); setPartnerTyping(false); setConnection('waiting for a match'); setView('matching')
    if (userId) void beginMatching()
  }

  const report = async () => { if (supabase && userId && partnerId && matchId) await supabase.from('tomble_reports').insert({ reporter_id: userId, reported_id: partnerId, match_id: matchId, reason: 'reported from chat' }); alert('Thanks. This report has been recorded.') }
  const block = async () => { if (supabase && userId && partnerId) { await supabase.from('tomble_blocks').upsert({ blocker_id: userId, blocked_id: partnerId }); await nextTomble() } }

  return <main className="tomble-app">
    <div className="ambient ambient-one" aria-hidden="true" /><div className="ambient ambient-two" aria-hidden="true" />
    <header className="topbar"><button className="brand" onClick={() => setView('home')} aria-label="Go to Tomble home"><span className="brand-mark">t</span> tomble<span className="brand-dot">.</span></button><div className="session-status"><span className="status-dot" /> temporary session</div><button className="avatar-button" onClick={() => setView('username')} aria-label="Change temporary nickname">{username[0]}</button></header>
    {view === 'home' && <><section className="hero-wrap"><div className="hero-copy"><p className="eyebrow"><span className="status-dot" /> a softer way to meet online</p><h1>meet someone<br /><em>unexpected.</em></h1><p className="hero-text">Tomble pairs you with a random girl for a real conversation. No swiping. No accounts. Just a little bit of serendipity.</p><div className="hero-actions"><button className="primary-button" onClick={start}>Start Tombling <span>↗</span></button><button className="text-button" onClick={() => document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' })}>How it works <span>↓</span></button></div><p className="fine-print">18+ · anonymous, temporary, and made for women who like women</p></div><div className="hero-art" aria-label="A preview of Tomble matching two people"><div className="scribble scribble-top">no pressure</div><div className="profile-card card-back"><div className="face face-mint">N</div><span>curious soul</span></div><div className="profile-card card-front"><div className="face face-coral">M</div><div><strong>Maya, 24</strong><span>online now · no profile required</span></div><div className="spark">✦</div></div><div className="match-pill"><span>✦</span> random, but never really</div><div className="scribble scribble-bottom">say hey?</div></div></section><section className="how-section" id="how"><div><p className="eyebrow">the simple version</p><h2>less performing.<br /><em>more connecting.</em></h2></div><div className="steps"><article><span>01</span><h3>confirm</h3><p>Say you are 18+. No documents, no account.</p></article><article><span>02</span><h3>tumble</h3><p>Pick a temporary nickname and a few interests.</p></article><article><span>03</span><h3>say hey</h3><p>Chat anonymously, then skip whenever you want.</p></article></div></section></>}
    {view === 'age' && <section className="panel-section setup-panel"><div className="panel-heading"><p className="eyebrow">one quick check</p><h2>Tomble is for adults<br /><em>18+ only.</em></h2><p>We do not collect identification documents. Just confirm that you are old enough to join the conversation.</p></div><div className="setup-form"><label className="check-row"><input type="checkbox" id="age-confirm" /> <span>I am 18 or older</span></label><button className="primary-button full" onClick={() => { const checked = document.getElementById('age-confirm') as HTMLInputElement; if (checked?.checked) setView('username') }}>Continue <span>↗</span></button></div></section>}
    {view === 'username' && <section className="panel-section setup-panel"><div className="panel-heading"><p className="eyebrow">temporary by design</p><h2>what should we<br /><em>call you?</em></h2><p>Choose a nickname for this session only. No email, account, or real name needed.</p></div><div className="setup-form"><label>Temporary nickname<input value={username} onChange={(event) => setUsername(event.target.value.slice(0, 24))} placeholder="Luna" maxLength={24} /></label><button className="primary-button full" onClick={() => username.trim() && setView('interests')}>Choose interests <span>↗</span></button></div></section>}
    {view === 'interests' && <section className="panel-section setup-panel"><div className="panel-heading"><p className="eyebrow">make it feel less random</p><h2>what are you<br /><em>into lately?</em></h2><p>Pick a few things. We use them to find a more natural first hello.</p></div><div className="interest-grid">{interestOptions.map((interest) => <button key={interest} className={interests.includes(interest) ? 'interest-chip selected' : 'interest-chip'} onClick={() => toggleInterest(interest)}>{interest}</button>)}</div><button className="primary-button full" onClick={beginMatching}>Start Tombling <span>↗</span></button></section>}
    {view === 'matching' && <section className="matching-section"><div className="matching-orbit"><div className="orbit-ring" /><div className="mini-avatar mini-one">{username[0]}</div><div className="mini-avatar mini-two">{current.name[0]}</div><div className="orbit-center">t<span>.</span></div></div><p className="eyebrow">{connection === 'connected' ? 'match found' : 'finding someone...'}</p><h2>{connection === 'connected' ? <>you found your<br /><em>kind of strange.</em></> : <>looking for your<br /><em>kind of strange...</em></>}</h2><p className="matching-note">{connection}. Session {sessionId.slice(0, 8)}…</p><div className="loading-line"><span /></div><button className="text-button" onClick={() => setView('chat')}>skip the suspense →</button></section>}
    {view === 'chat' && <section className="chat-section"><div className="chat-header"><button className="back-button" onClick={() => setView('matching')} aria-label="Back to matching">←</button><div className={`face small face-${current.color}`}>{current.name[0]}</div><div><strong>{current.name}, {current.age}</strong><span>anonymous match · {connection}</span></div><button className="more-button" onClick={report} aria-label="Report this person">•••</button></div><div className="chat-intro"><span className="intro-line" /><p>You both showed up for a<br /><strong>good conversation.</strong></p><span className="intro-line" /></div><div className="messages" ref={listRef}>{messages.length === 0 && <div className="empty-chat">Say hello to start the conversation.</div>}{messages.map((item) => <div key={item.id} className={`message-row ${item.from === 'me' ? 'mine' : ''} animate-in fade-in slide-in-from-bottom-2 duration-300`}><div className={`message-wrapper ${item.from === 'me' ? 'mine' : ''}`}><div className="message"><small>{item.from === 'me' ? 'You' : current.name}</small>{item.text}</div>{item.id === lastReadMessageId && item.from === 'me' && <span style={{ fontSize: 10, color: 'rgba(32,20,38,0.5)', marginTop: 4, marginRight: 4 }}>Read</span>}</div></div>)}{partnerTyping && <div className="message-row animate-in fade-in slide-in-from-bottom-2 duration-300"><div className="message typing-indicator"><span/><span/><span/></div></div>}</div><div className="chat-footer"><button className="soft-button" onClick={report}>report</button><button className="soft-button" onClick={block}>block</button><input value={message} onChange={(event) => handleTyping(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) void send() }} placeholder="say something nice..." aria-label="Message" maxLength={500} /><button className="send-button" onClick={() => void send()} disabled={isSending} aria-label="Send message">↑</button></div><button className="next-button" onClick={() => void nextTomble()}>Next Tomble <span>→</span></button></section>}
    <footer className="footer"><span>tomble<span className="brand-dot">.</span></span><span>temporary by design · session expires when you leave</span><span>community guidelines ↗</span></footer>
  </main>
}
