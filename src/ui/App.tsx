import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

type Player = { id: string; first: string; last: string; attended: number; missed: number; registered: boolean }
type Profile = { id: string; first_name: string; last_name: string; status: 'pending' | 'approved' | 'rejected'; role: 'player' | 'manager' }
type ManagerMatch = { id: string; week_start: string; players: Array<Player & { result: string }> }

const initialPlayers: Player[] = [
  { id: 'demo-1', first: 'איתי', last: 'כהן', attended: 2, missed: 0, registered: true },
  { id: 'demo-2', first: 'נועם', last: 'לוי', attended: 4, missed: 1, registered: false },
  { id: 'demo-3', first: 'דניאל', last: 'פרץ', attended: 1, missed: 0, registered: true },
  { id: 'demo-4', first: 'עומר', last: 'מזרחי', attended: 3, missed: 0, registered: false },
]

function App() {
  const live = Boolean(supabase)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [players, setPlayers] = useState(initialPlayers)
  const [registered, setRegistered] = useState(true)
  const [registrationOpen, setRegistrationOpen] = useState(true)
  const [showJoin, setShowJoin] = useState(false)
  const [authMode, setAuthMode] = useState<'join' | 'login'>('join')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [community, setCommunity] = useState(false)
  const [requestSent, setRequestSent] = useState(false)
  const [needsEmailConfirmation, setNeedsEmailConfirmation] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [showManager, setShowManager] = useState(false)
  const [pendingMembers, setPendingMembers] = useState<Profile[]>([])
  const [managerMatches, setManagerMatches] = useState<ManagerMatch[]>([])
  const [busy, setBusy] = useState(false)

  const registeredCount = useMemo(() => players.filter((player) => player.registered).length, [players])

  useEffect(() => {
    if (!supabase) return
    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (active) setUser(data.session?.user ?? null)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      setProfile(null)
    })
    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!supabase || !user) {
      setProfile(null)
      return
    }
    let active = true
    supabase.from('profiles').select('id, first_name, last_name, status, role').eq('id', user.id).maybeSingle()
      .then(({ data }) => { if (active) setProfile(data as Profile | null) })
    return () => { active = false }
  }, [user])

  useEffect(() => {
    if (!supabase) {
      setPlayers(initialPlayers)
      setRegistered(true)
      setRegistrationOpen(true)
      return
    }
    if (!user) {
      setPlayers([])
      setRegistered(false)
      setRegistrationOpen(true)
      return
    }
    let active = true
    async function loadWeek() {
      const [weekResponse, openResponse] = await Promise.all([
        supabase!.rpc('current_week_start'),
        supabase!.rpc('signup_week_for_now'),
      ])
      if (!active) return
      if (weekResponse.error || openResponse.error) {
        setNotice('לא הצלחנו לטעון את מצב ההרשמה כרגע.')
        return
      }
      const currentWeek = weekResponse.data as string | null
      const openWeek = openResponse.data as string | null
      setRegistrationOpen(Boolean(openWeek))
      if (!currentWeek) return
      const { data: match, error: matchError } = await supabase!.from('matches').select('id, status').eq('week_start', currentWeek).maybeSingle()
      if (!active) return
      if (matchError || !match) {
        setPlayers([])
        setRegistered(false)
        return
      }
      const { data: entries, error: entriesError } = await supabase!.from('match_entries')
        .select('player_id, result, selection_rank').eq('match_id', match.id).is('cancelled_at', null)
      if (!active) return
      if (entriesError || !entries) return
      setRegistered(entries.some((entry) => entry.player_id === user.id))
      const visibleEntries = openWeek ? entries : entries.filter((entry) => entry.selection_rank !== null)
      const ids = visibleEntries.map((entry) => entry.player_id)
      if (!ids.length) {
        setPlayers([])
        return
      }
      const [profilesResponse, statsResponse] = await Promise.all([
        supabase!.from('profiles').select('id, first_name, last_name').in('id', ids),
        supabase!.from('player_recent_stats').select('player_id, attended_last_8, no_shows_last_8').in('player_id', ids),
      ])
      if (!active) return
      const stats = new Map((statsResponse.data ?? []).map((row) => [row.player_id, row]))
      const names = new Map((profilesResponse.data ?? []).map((row) => [row.id, row]))
      const fetchedPlayers = visibleEntries.flatMap((entry) => {
        const name = names.get(entry.player_id)
        if (!name) return []
        const playerStats = stats.get(entry.player_id)
        return [{
          id: entry.player_id,
          first: name.first_name,
          last: name.last_name,
          attended: playerStats?.attended_last_8 ?? 0,
          missed: playerStats?.no_shows_last_8 ?? 0,
          registered: true,
        }]
      })
      setPlayers(fetchedPlayers)
    }
    void loadWeek()
    return () => { active = false }
  }, [user, refreshKey])

  useEffect(() => {
    if (!supabase || !showManager || profile?.role !== 'manager' || profile.status !== 'approved') return
    let active = true
    async function loadManagerBoard() {
      const [pendingResponse, matchesResponse] = await Promise.all([
        supabase!.from('profiles').select('id, first_name, last_name, status, role').eq('status', 'pending').order('created_at'),
        supabase!.from('matches').select('id, week_start, status').in('status', ['selected', 'completed']).order('week_start', { ascending: false }).limit(4),
      ])
      if (!active) return
      setPendingMembers((pendingResponse.data ?? []) as Profile[])
      const matches = matchesResponse.data ?? []
      const ids = matches.map((match) => match.id)
      if (!ids.length) { setManagerMatches([]); return }
      const { data: entries } = await supabase!.from('match_entries').select('match_id, player_id, result, selection_rank').in('match_id', ids).not('selection_rank', 'is', null)
      const playerIds = [...new Set((entries ?? []).map((entry) => entry.player_id))]
      const { data: names } = playerIds.length
        ? await supabase!.from('profiles').select('id, first_name, last_name').in('id', playerIds)
        : { data: [] }
      if (!active) return
      const nameMap = new Map((names ?? []).map((item) => [item.id, item]))
      setManagerMatches(matches.map((match) => ({
        id: match.id,
        week_start: match.week_start,
        players: (entries ?? []).filter((entry) => entry.match_id === match.id).flatMap((entry) => {
          const name = nameMap.get(entry.player_id)
          return name ? [{ id: entry.player_id, first: name.first_name, last: name.last_name, attended: 0, missed: 0, registered: true, result: entry.result }] : []
        }),
      })))
    }
    void loadManagerBoard()
    return () => { active = false }
  }, [showManager, profile, refreshKey])

  function openAuth(mode: 'join' | 'login') {
    setAuthMode(mode)
    setRequestSent(false)
    setFormError('')
    setShowJoin(true)
  }

  async function toggleSignup() {
    if (!supabase) {
      setRegistered((current) => !current)
      setPlayers((current) => current.map((player) => player.id === 'demo-1' ? { ...player, registered: !registered } : player))
      return
    }
    if (!user) { openAuth('login'); return }
    if (profile?.status !== 'approved') { setNotice('בקשת ההצטרפות שלך עדיין ממתינה לאישור מנהל.'); return }
    if (!registrationOpen) { setNotice('ההרשמה נסגרה.'); return }
    setBusy(true)
    const { error } = await supabase.rpc('set_weekly_signup', { p_join: !registered })
    setBusy(false)
    if (error) setNotice(error.message.includes('Signup is closed') ? 'ההרשמה נסגרה.' : 'לא הצלחנו לעדכן את ההרשמה.')
    else { setNotice(!registered ? 'נרשמת למשחק השבועי.' : 'ההרשמה שלך בוטלה.'); setRefreshKey((value) => value + 1) }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError('')
    if (!supabase) { setRequestSent(true); return }
    setBusy(true)
    if (authMode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      setBusy(false)
      if (error) setFormError('פרטי ההתחברות לא אומתו. בדקו את האימייל והסיסמה.')
      else setShowJoin(false)
      return
    }
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { first_name: firstName, last_name: lastName, community_registered: community } },
    })
    setBusy(false)
    if (error) { setFormError(error.message.includes('already registered') ? 'כבר קיים חשבון עם כתובת האימייל הזו.' : 'לא הצלחנו לשלוח את הבקשה. בדקו את הפרטים ונסו שוב.'); return }
    setNeedsEmailConfirmation(!data.session)
    setRequestSent(true)
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut()
    setShowManager(false)
    setNotice('התנתקת מהחשבון.')
  }

  async function approveMember(id: string, approve: boolean) {
    if (!supabase) return
    const { error } = await supabase.rpc('request_approval', { p_player_id: id, p_approve: approve })
    if (error) setNotice('לא הצלחנו לעדכן את בקשת ההצטרפות.')
    else { setNotice(approve ? 'השחקן אושר.' : 'בקשת ההצטרפות נדחתה.'); setRefreshKey((value) => value + 1) }
  }

  async function recordAttendance(matchId: string, playerId: string, attended: boolean) {
    if (!supabase) return
    const { error } = await supabase.rpc('record_attendance', { p_match_id: matchId, p_player_id: playerId, p_attended: attended })
    if (error) setNotice('לא הצלחנו לשמור את הנוכחות.')
    else { setNotice('הנוכחות נשמרה.'); setRefreshKey((value) => value + 1) }
  }

  const userIsRegistered = live ? Boolean(user && registered) : registered
  const canSignUp = !live || (user !== null && profile?.status === 'approved' && registrationOpen)

  return (
    <main className="page-shell">
      <div className="preview-note"><span className="preview-dot" />{live ? 'מחובר למסד הנתונים · אזור ההרשמה פעיל' : 'תצוגה מקדימה · ההרשמות נשמרות רק בתצוגה הזו'}</div>
      <header className="topbar">
        <a className="brand" href="#home" aria-label="מועדון הכדורגל — עמוד הבית">
          <span className="brand-mark" aria-hidden="true">⚽</span>
          <span><strong>המשחק השבועי</strong><small>מועדון הכדורגל שלנו</small></span>
        </a>
        <div className="top-actions">
          {profile?.role === 'manager' && profile.status === 'approved' && <button className="button button-quiet manager-toggle" onClick={() => setShowManager((open) => !open)}>{showManager ? 'עמוד ההרשמה' : 'לוח מנהל'}</button>}
          {user ? <button className="button button-quiet desktop-join" onClick={signOut}>התנתקות</button> : <button className="button button-quiet desktop-join" onClick={() => openAuth('join')}>הצטרפות למועדון</button>}
          <button className="mobile-menu" aria-label="פתיחת טופס הצטרפות" onClick={() => openAuth(user ? 'login' : 'join')}><span /><span /></button>
        </div>
      </header>

      {!showManager && <>
        <section className="hero" id="home">
          <div className="hero-copy">
            <div className="eyebrow"><span className="live-dot" /> {registrationOpen ? 'ההרשמה פתוחה עכשיו' : 'ההרשמה השבועית נסגרה'}</div>
            <h1>נתראה<br /><em>על הדשא.</em></h1>
            <p className="intro">משחק טוב מתחיל בקבוצה טובה. שריינו מקום למשחק השבועי שלנו.</p>
            <div className="hero-meta">
              <div className="meta-item"><span className="meta-icon">◷</span><span><small>ההרשמה נסגרת</small><strong>יום שני · 08:00</strong></span></div>
              <div className="meta-item"><span className="meta-icon">⌖</span><span><small>מיקום המשחק</small><strong>המגרש הקבוע</strong></span></div>
            </div>
            <div className="hero-actions">
              <button className={`button button-primary ${userIsRegistered ? 'button-registered' : ''}`} onClick={() => { if (canSignUp) void toggleSignup(); else if (live && !user) openAuth('login'); else setNotice(profile?.status === 'pending' ? 'בקשת ההצטרפות ממתינה לאישור מנהל.' : 'ההרשמה נסגרה.') }} disabled={busy}>
                {busy ? 'שומרים…' : live && !user ? 'התחברות להרשמה' : live && profile?.status === 'pending' ? 'ממתין לאישור מנהל' : live && !registrationOpen ? 'ההרשמה נסגרה' : userIsRegistered ? '✓  נרשמת למשחק' : 'הרשמה למשחק'}
              </button>
              {userIsRegistered && registrationOpen && <button className="text-button" onClick={toggleSignup}>ביטול הרשמה</button>}
            </div>
            <p className="timezone-note">{profile?.status === 'pending' ? 'לאחר האישור תוכל להירשם למשחק השבועי.' : 'אפשר להירשם או לבטל עד סגירת ההרשמה'}</p>
          </div>
          <div className="hero-art" role="img" aria-label="מגרש כדורגל ירוק בשעת ערב">
            <div className="art-glow" /><div className="field-lines"><span /><span /><span /></div><div className="ball">⚽</div>
            <div className="art-caption"><span>01 / 08</span><span>שומרים על המסורת</span></div>
          </div>
        </section>

        <section className="signup-panel" aria-label="מצב ההרשמה">
          <div className="signup-summary">
            <div><span className="section-kicker">ההרשמה השבועית</span><h2>{registrationOpen ? 'מי עולה למגרש?' : 'ההרכב השבועי'}</h2></div>
            <div className="spots"><strong>{String(registeredCount).padStart(2, '0')}</strong><span>{registrationOpen ? 'נרשמו' : 'נבחרו'}<br />עד עכשיו</span><i /> <span className="spots-total">15<br />מקומות בהרכב</span></div>
          </div>
          <div className="progress-track"><span style={{ width: `${Math.min(100, registeredCount / 15 * 100)}%` }} /></div>
          <div className="list-heading"><h3>{registrationOpen ? 'נרשמים לשבוע' : 'ההרכב שנבחר'}</h3><span>{registrationOpen ? 'ההרכב הסופי ייקבע עם סגירת ההרשמה' : 'הרכב של עד 15 שחקנים'}</span></div>
          <div className="player-list">
            {players.map((player, index) => (
              <div className="player-row" key={player.id}>
                <span className="player-number">{String(index + 1).padStart(2, '0')}</span><span className="avatar">{player.first.slice(0, 1)}</span>
                <strong>{player.first} {player.last}</strong><span className="player-stat">{player.attended} הגעות ב־8 שבועות</span>
                {player.id === user?.id && <span className="you-badge">אתה</span>}
              </div>
            ))}
            {registeredCount === 0 && <p className="empty-list">{live && !user ? 'התחברו כדי לראות את רשימת הנרשמים.' : registrationOpen ? 'עוד לא נרשמו השבוע. אולי תהיה הראשון?' : 'הבחירה השבועית מתבצעת. הרשימה תוצג כאן.'}</p>}
          </div>
          <div className="selection-note"><span className="info-mark">i</span><p>ההרכב נקבע אחרי סגירת ההרשמה לפי היסטוריית ההשתתפות בשמונת השבועות האחרונים. בכל משחק נבחרים עד 15 שחקנים.</p></div>
        </section>
      </>}

      {showManager && <section className="manager-panel">
        <span className="section-kicker">ניהול המועדון</span><h2>לוח מנהל</h2>
        <div className="manager-section"><div className="list-heading"><h3>בקשות הצטרפות ממתינות</h3><span>{pendingMembers.length} בקשות</span></div>
          {pendingMembers.length ? pendingMembers.map((member) => <div className="manager-row" key={member.id}><div><strong>{member.first_name} {member.last_name}</strong><small>נרשם במתנ״ס</small></div><div className="manager-actions"><button className="approve-button" onClick={() => approveMember(member.id, true)}>אישור</button><button className="reject-button" onClick={() => approveMember(member.id, false)}>דחייה</button></div></div>) : <p className="empty-list">אין בקשות שממתינות לאישור.</p>}
        </div>
        <div className="manager-section"><div className="list-heading"><h3>עדכון נוכחות</h3><span>משחקים אחרונים</span></div>
          {managerMatches.map((match) => <div className="attendance-match" key={match.id}><h4>שבוע שמתחיל ב־{new Date(`${match.week_start}T12:00:00`).toLocaleDateString('he-IL')}</h4>{match.players.map((player) => <div className="manager-row" key={player.id}><strong>{player.first} {player.last}</strong>{player.result === 'selected' ? <div className="manager-actions"><button className="approve-button" onClick={() => recordAttendance(match.id, player.id, true)}>הגיע</button><button className="reject-button" onClick={() => recordAttendance(match.id, player.id, false)}>לא הגיע</button></div> : <span className="player-stat">{player.result === 'attended' ? 'הגיע' : 'לא הגיע'}</span>}</div>)}</div>)}
          {!managerMatches.length && <p className="empty-list">לא נמצאו משחקים שממתינים לעדכון נוכחות.</p>}
        </div>
      </section>}

      {notice && <div className="notice" role="status"><span>{notice}</span><button aria-label="סגירה" onClick={() => setNotice('')}>×</button></div>}
      <footer className="footer"><span>כדורגל זה יותר ממשחק.</span><span>נפגשים על הדשא <b>·</b> כל שבוע</span></footer>

      {showJoin && <div className="modal-backdrop" role="presentation" onClick={() => setShowJoin(false)}>
        <section className="join-modal" role="dialog" aria-modal="true" aria-labelledby="join-title" onClick={(event) => event.stopPropagation()}>
          <button className="modal-close" aria-label="סגירה" onClick={() => setShowJoin(false)}>×</button>
          {requestSent ? <div className="success-state"><span>✓</span><h2 id="join-title">{authMode === 'login' ? 'תצוגת התחברות' : live ? 'הבקשה התקבלה' : 'בקשת ההצטרפות התקבלה'}</h2><p>{authMode === 'login' ? 'התחברות תופעל לאחר חיבור הפרויקט למסד הנתונים.' : live ? needsEmailConfirmation ? 'שלחנו קישור אימות לאימייל. אחרי האימות, מנהל המועדון יאשר את הבקשה.' : 'מנהל המועדון יעבור על הבקשה לפני שתוכל להירשם למשחק.' : 'זו תצוגה מקדימה. חיבור למסד הנתונים ישמור את בקשת ההצטרפות ויעביר אותה למנהל.'}</p><button className="button button-primary" onClick={() => setShowJoin(false)}>הבנתי</button></div> : <>
            <span className="section-kicker">{authMode === 'join' ? 'ברוכים הבאים לקבוצה' : 'טוב לראות אותך שוב'}</span><h2 id="join-title">{authMode === 'join' ? 'בקשת הצטרפות' : 'התחברות'}</h2>
            <p className="modal-intro">{authMode === 'join' ? 'מלאו את הפרטים. מנהל המועדון יאשר את הבקשה לפני ההרשמה הראשונה.' : 'התחברו לחשבון המאושר כדי לנהל את ההרשמה השבועית.'}</p>
            <form onSubmit={submitAuth}>
              {authMode === 'join' && <><label>שם פרטי<input required value={firstName} onChange={(event) => setFirstName(event.target.value)} placeholder="למשל, עידו" /></label><label>שם משפחה<input required value={lastName} onChange={(event) => setLastName(event.target.value)} placeholder="למשל, ישראלי" /></label></>}
              <label>כתובת אימייל<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" dir="ltr" /></label>
              <label>סיסמה<input required type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="לפחות 8 תווים" dir="ltr" /></label>
              {authMode === 'join' && <label className="check-label"><input required type="checkbox" checked={community} onChange={(event) => setCommunity(event.target.checked)} /><span>נרשמתי במתנ״ס</span></label>}
              {formError && <p className="form-error" role="alert">{formError}</p>}
              <button className="button button-primary modal-submit" type="submit" disabled={busy}>{busy ? 'רק רגע…' : authMode === 'join' ? 'שליחת בקשת הצטרפות' : 'התחברות'}</button>
              <button className="switch-auth" type="button" onClick={() => { setAuthMode(authMode === 'join' ? 'login' : 'join'); setFormError('') }}>{authMode === 'join' ? 'כבר יש לך חשבון? התחברות' : 'חדש במועדון? בקשת הצטרפות'}</button>
              {authMode === 'join' && <p className="form-footnote">הבקשה תמתין לאישור מנהל לפני יצירת חשבון פעיל.</p>}
            </form>
          </>}
        </section>
      </div>}
    </main>
  )
}

export default App
