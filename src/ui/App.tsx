import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

type Player = { id: string; first: string; last: string; attended: number; missed: number; registered: boolean; selectionRank?: number | null; signupTime?: string }
type Profile = { id: string; first_name: string; last_name: string; status: 'pending' | 'approved' | 'rejected'; role: 'player' | 'manager' }
type ManagerMatch = { id: string; week_start: string; status: string; players: Array<Player & { result: string }> }

function formatWeekDate(week: string | null, offsetDays = 0) {
  if (!week) return ''
  const date = new Date(`${week}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date)
}

const initialPlayers: Player[] = [
  { id: 'demo-1', first: 'איתי', last: 'כהן', attended: 2, missed: 0, registered: true },
  { id: 'demo-2', first: 'נועם', last: 'לוי', attended: 4, missed: 1, registered: false },
  { id: 'demo-3', first: 'דניאל', last: 'פרץ', attended: 1, missed: 0, registered: true },
  { id: 'demo-4', first: 'עומר', last: 'מזרחי', attended: 3, missed: 0, registered: false },
]

function App() {
  const live = Boolean(supabase)
  const [now, setNow] = useState(() => new Date())
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [players, setPlayers] = useState(initialPlayers)
  const [registered, setRegistered] = useState(true)
  const [registrationOpen, setRegistrationOpen] = useState(true)
  const [openSignupWeek, setOpenSignupWeek] = useState<string | null>(null)
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
  const [openMemberMenuId, setOpenMemberMenuId] = useState<string | null>(null)
  const [pendingSignupState, setPendingSignupState] = useState<boolean | null>(null)
  const [pendingMembers, setPendingMembers] = useState<Profile[]>([])
  const [approvedMembers, setApprovedMembers] = useState<Profile[]>([])
  const [managerMatches, setManagerMatches] = useState<ManagerMatch[]>([])
  const [busy, setBusy] = useState(false)

  const registeredCount = useMemo(() => players.filter((player) => player.registered).length, [players])
  const selectedPlayers = useMemo(() => players.filter((player) => player.selectionRank != null).sort((a, b) => a.selectionRank! - b.selectionRank!), [players])
  const additionalPlayers = useMemo(() => players.filter((player) => player.selectionRank == null).sort((a, b) => (a.signupTime ?? '').localeCompare(b.signupTime ?? '')), [players])
  const todayDate = useMemo(() => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' }).format(now), [now])
  const nextSignupBoundary = useMemo(() => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now)
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday'))
    const hour = Number(value('hour'))
    const isOpen = (day === 0 && hour >= 9) || (day === 1 && hour < 9)
    const daysUntilBoundary = isOpen ? (day === 1 ? 0 : 1) : (7 - day) % 7
    const boundary = new Date(Date.UTC(Number(value('year')), Number(value('month')) - 1, Number(value('day')) + daysUntilBoundary, 9))
    const weekStart = new Date(Date.UTC(Number(value('year')), Number(value('month')) - 1, Number(value('day')) - day))
    const weekStartValue = `${weekStart.getUTCFullYear()}-${String(weekStart.getUTCMonth() + 1).padStart(2, '0')}-${String(weekStart.getUTCDate()).padStart(2, '0')}`
    const formattedDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(boundary)
    return { isOpen, date: formattedDate, weekStart: weekStartValue }
  }, [now])
  const displayedSignupBoundary = useMemo(() => {
    if (registrationOpen && openSignupWeek) return { label: 'סגירת ההרשמה', date: formatWeekDate(openSignupWeek, 1) }
    if (!registrationOpen && nextSignupBoundary.isOpen) return { label: 'פתיחת הרשמה הבאה', date: formatWeekDate(nextSignupBoundary.weekStart, 7) }
    return { label: nextSignupBoundary.isOpen ? 'סגירת ההרשמה' : 'פתיחת הרשמה הבאה', date: nextSignupBoundary.date }
  }, [registrationOpen, openSignupWeek, nextSignupBoundary])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!supabase) {
      setRegistrationOpen(nextSignupBoundary.isOpen)
      return
    }
    let active = true
    supabase.rpc('signup_week_for_now').then(({ data, error }) => {
      if (active && !error) {
        const week = data as string | null
        setOpenSignupWeek(week)
        setRegistrationOpen(Boolean(week))
      }
    })
    return () => { active = false }
  }, [nextSignupBoundary.isOpen, refreshKey])

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
      setOpenSignupWeek(openWeek)
      const weekToLoad = openWeek ?? currentWeek
      if (!weekToLoad) return
      const { data: match, error: matchError } = await supabase!.from('matches').select('id, status').eq('week_start', weekToLoad).maybeSingle()
      if (!active) return
      if (matchError || !match) {
        setPlayers([])
        setRegistered(false)
        return
      }
      const { data: entries, error: entriesError } = await supabase!.from('match_entries')
        .select('player_id, result, selection_rank, signed_up_at').eq('match_id', match.id).is('cancelled_at', null)
      if (!active) return
      if (entriesError || !entries) return
      setRegistered(entries.some((entry) => entry.player_id === user!.id))
      const selectionComplete = match.status !== 'signup'
      const visibleEntries = openWeek ? entries : selectionComplete ? entries : []
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
      const orderedEntries = [...visibleEntries].sort((a, b) => {
        if (a.selection_rank !== null && b.selection_rank !== null) return a.selection_rank - b.selection_rank
        if (a.selection_rank !== null) return -1
        if (b.selection_rank !== null) return 1
        return a.signed_up_at.localeCompare(b.signed_up_at)
      })
      const fetchedPlayers = orderedEntries.flatMap((entry) => {
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
          selectionRank: entry.selection_rank,
          signupTime: entry.signed_up_at,
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
      const [pendingResponse, approvedResponse, matchesResponse] = await Promise.all([
        supabase!.from('profiles').select('id, first_name, last_name, status, role').eq('status', 'pending').order('created_at'),
        supabase!.from('profiles').select('id, first_name, last_name, status, role').eq('status', 'approved').order('first_name').order('last_name'),
        supabase!.from('matches').select('id, week_start, status').in('status', ['signup', 'selected', 'completed']).order('week_start', { ascending: false }).limit(4),
      ])
      if (!active) return
      setPendingMembers((pendingResponse.data ?? []) as Profile[])
      setApprovedMembers((approvedResponse.data ?? []) as Profile[])
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
        status: match.status,
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

  async function updateSignupState() {
    if (pendingSignupState === null || !supabase) return
    const nextState = pendingSignupState
    setBusy(true)
    const { error } = await supabase.rpc('set_signup_open', { p_is_open: nextState })
    setBusy(false)
    setPendingSignupState(null)
    if (error) {
      setNotice(error.message.includes('already finalized') ? 'לא הצלחנו לפתוח הרשמה לשבוע הבא.' : 'לא הצלחנו לשנות את מצב ההרשמה.')
      return
    }
    setRegistrationOpen(nextState)
    if (!nextState) setOpenSignupWeek(null)
    setNotice(nextState ? 'ההרשמה נפתחה.' : 'ההרשמה נסגרה.')
    setRefreshKey((value) => value + 1)
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

  async function revokeApproval(member: Profile) {
    if (!supabase || member.id === user?.id) return
    if (!window.confirm(`להסיר את ${member.first_name} ${member.last_name} מהקבוצה? החשבון יועבר לבקשות הממתינות.`)) return
    const { error } = await supabase.rpc('revoke_member_approval', { p_player_id: member.id })
    if (error) setNotice('לא הצלחנו להסיר את האישור.')
    else { setOpenMemberMenuId(null); setNotice(`${member.first_name} ${member.last_name} הועבר לבקשות הממתינות.`); setRefreshKey((value) => value + 1) }
  }

  async function changeMemberRole(member: Profile, role: Profile['role']) {
    if (!supabase || member.id === user?.id) return
    const action = role === 'manager' ? 'להפוך למנהל' : 'להסיר את הרשאת המנהל של'
    if (!window.confirm(`${action} ${member.first_name} ${member.last_name}?`)) return
    const { error } = await supabase.rpc('set_member_role', { p_player_id: member.id, p_role: role })
    if (error) setNotice('לא הצלחנו לעדכן את הרשאת המשתמש.')
    else { setOpenMemberMenuId(null); setNotice(role === 'manager' ? `${member.first_name} ${member.last_name} הוגדר כמנהל.` : `הרשאת המנהל של ${member.first_name} ${member.last_name} הוסרה.`); setRefreshKey((value) => value + 1) }
  }

  async function recordAttendance(matchId: string, playerId: string, attended: boolean) {
    if (!supabase) return
    const { error } = await supabase.rpc('record_attendance', { p_match_id: matchId, p_player_id: playerId, p_attended: attended })
    if (error) setNotice('לא הצלחנו לשמור את הנוכחות.')
    else { setNotice('הנוכחות נשמרה.'); setRefreshKey((value) => value + 1) }
  }

  async function finalizeMatch(weekStart: string) {
    if (!supabase) return
    const { error } = await supabase.rpc('finalize_weekly_signup', { p_week: weekStart })
    if (error) setNotice(error.message.includes('Signup is still open') ? 'ההרשמה עדיין פתוחה.' : 'לא הצלחנו לבצע את בחירת השחקנים.')
    else { setNotice('הרכב המשחק נבחר.'); setRefreshKey((value) => value + 1) }
  }

  const userIsRegistered = live ? Boolean(user && registered) : registered
  const displayedPlayerCount = registrationOpen ? registeredCount : selectedPlayers.length
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
          {user ? <button className="button button-quiet desktop-join" onClick={signOut}>התנתקות</button> : <>
            <button className="button button-quiet desktop-join" onClick={() => openAuth('login')}>התחברות</button>
            <button className="button button-quiet desktop-join" onClick={() => openAuth('join')}>הצטרפות למועדון</button>
          </>}
          {user
            ? <button className="button button-quiet mobile-menu" aria-label="התנתקות" onClick={signOut}>יציאה</button>
            : <>
              <button className="button button-quiet mobile-menu" onClick={() => openAuth('login')}>התחברות</button>
              <button className="button button-quiet mobile-menu" aria-label="הצטרפות למועדון" onClick={() => openAuth('join')}>הצטרפות</button>
            </>}
        </div>
      </header>

      {!showManager && <>
        <section className="hero" id="home">
          <div className="hero-copy">
            <div className="eyebrow"><span className="live-dot" /> {registrationOpen ? 'ההרשמה פתוחה עכשיו' : 'ההרשמה השבועית נסגרה'}</div>
            <h1>נתראה<br /><em>על הדשא.</em></h1>
            <p className="intro">משחק טוב מתחיל בקבוצה טובה. שריינו מקום למשחק השבועי שלנו.</p>
            <div className="hero-meta">
              <div className="meta-item"><span className="meta-icon">◷</span><span><small>{displayedSignupBoundary.label}</small><strong>{displayedSignupBoundary.date} · 09:00</strong></span></div>
              <div className="meta-item"><span className="meta-icon">⌖</span><span><small>מיקום המשחק</small><strong>גינות שומרון</strong></span></div>
            </div>
            <div className="hero-actions">
              <button className={`button button-primary ${userIsRegistered ? 'button-registered' : ''}`} onClick={() => { if (canSignUp) void toggleSignup(); else if (live && !user) openAuth('login'); else setNotice(profile?.status === 'pending' ? 'בקשת ההצטרפות ממתינה לאישור מנהל.' : profile?.status === 'rejected' ? 'בקשת ההצטרפות נדחתה. פנו למנהל המועדון.' : 'ההרשמה נסגרה.') }} disabled={busy}>
                {busy ? 'שומרים…' : live && !user ? 'התחברות להרשמה' : live && profile?.status === 'pending' ? 'ממתין לאישור מנהל' : live && profile?.status === 'rejected' ? 'הבקשה נדחתה' : live && !registrationOpen ? 'ההרשמה נסגרה' : userIsRegistered ? '✓  נרשמת למשחק' : 'הרשמה למשחק'}
              </button>
              {userIsRegistered && registrationOpen && <button className="text-button" onClick={toggleSignup}>ביטול הרשמה</button>}
            </div>
            {(profile?.status === 'pending' || registrationOpen) && <p className="timezone-note">{profile?.status === 'pending' ? 'לאחר האישור תוכל להירשם למשחק השבועי.' : 'אפשר להירשם או לבטל עד סגירת ההרשמה'}</p>}
          </div>
          <div className="hero-art" role="img" aria-label="מגרש כדורגל ירוק בשעת ערב">
            <div className="art-glow" /><div className="field-lines"><span /><span /><span /></div><div className="ball">⚽</div>
            <div className="art-caption"><span>01 / 08</span><span>שומרים על המסורת</span></div>
          </div>
        </section>

        <section className="signup-panel" aria-label="מצב ההרשמה">
          <div className="signup-summary">
            <div><span className="section-kicker">ההרשמה השבועית</span><h2>{registrationOpen ? 'מי עולה למגרש?' : `ההרכב השבועי ${todayDate}`}</h2></div>
            <div className="spots"><strong>{String(displayedPlayerCount).padStart(2, '0')}</strong><span>{registrationOpen ? 'נרשמו' : 'נבחרו'}<br />עד עכשיו</span><i /> <span className="spots-total">15<br />מקומות בהרכב</span></div>
          </div>
          <div className="progress-track"><span style={{ width: `${Math.min(100, displayedPlayerCount / 15 * 100)}%` }} /></div>
          <div className="list-heading"><h3>{registrationOpen ? 'נרשמים לשבוע' : 'ההרכב שנבחר'}</h3><span>{registrationOpen ? 'ההרכב הסופי ייקבע עם סגירת ההרשמה' : 'ההרכב והמשך רשימת הנרשמים'}</span></div>
          <div className="player-list">
            {(registrationOpen ? players : selectedPlayers).map((player, index) => (
              <div className="player-row" key={player.id}>
                <span className="player-number">{String(index + 1).padStart(2, '0')}</span><span className="avatar">{player.first.slice(0, 1)}</span>
                <strong>{player.first} {player.last}</strong><span className="player-stat">{player.attended} הגעות · {player.missed} אי־הגעות</span>
                {player.id === user?.id && <span className="you-badge">אתה</span>}
              </div>
            ))}
            {!registrationOpen && additionalPlayers.length > 0 && <div className="player-list-divider"><span>נרשמו ולא נבחרו להרכב</span></div>}
            {!registrationOpen && additionalPlayers.map((player, index) => (
              <div className="player-row" key={player.id}>
                <span className="player-number">{String(selectedPlayers.length + index + 1).padStart(2, '0')}</span><span className="avatar">{player.first.slice(0, 1)}</span>
                <strong>{player.first} {player.last}</strong><span className="player-stat">{player.attended} הגעות · {player.missed} אי־הגעות</span>
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
        <div className="manager-section manager-section-signup"><div className="list-heading"><h3>ניהול הרשמה</h3><span>{registrationOpen ? `פתוחה · שבוע המשחק ${formatWeekDate(openSignupWeek)}` : 'ההרשמה סגורה'}</span></div>
          <div className="signup-admin-controls"><p>{registrationOpen ? 'שחקנים מאושרים יכולים להירשם או לבטל כרגע.' : 'שחקנים לא יכולים להירשם כרגע.'}</p><button className={registrationOpen ? 'reject-button' : 'approve-button'} onClick={() => setPendingSignupState(!registrationOpen)}>{registrationOpen ? 'סגירת הרשמה' : 'פתיחת הרשמה'}</button></div>
        </div>
        <div className="manager-section manager-section-pending"><div className="list-heading"><h3>בקשות הצטרפות ממתינות</h3><span>{pendingMembers.length} בקשות</span></div>
          {pendingMembers.length ? pendingMembers.map((member) => <div className="manager-row" key={member.id}><div><strong>{member.first_name} {member.last_name}</strong><small>נרשם במתנ״ס</small></div><div className="manager-actions"><button className="approve-button" onClick={() => approveMember(member.id, true)}>אישור</button><button className="reject-button" onClick={() => approveMember(member.id, false)}>דחייה</button></div></div>) : <p className="empty-list">אין בקשות שממתינות לאישור.</p>}
        </div>
        <div className="manager-section manager-section-approved"><div className="list-heading"><h3>משתמשים מאושרים</h3><span>{approvedMembers.length} משתמשים</span></div>
          {approvedMembers.length ? approvedMembers.map((member) => <div className="manager-row" key={member.id}><strong>{member.first_name} {member.last_name}</strong><div className="manager-member-actions">{member.role === 'manager' && <span className="manager-role-badge">מנהל</span>}{member.id !== user?.id && <div className="manager-member-menu"><button type="button" className="manager-member-menu-trigger" aria-label={`אפשרויות עבור ${member.first_name} ${member.last_name}`} aria-haspopup="menu" aria-expanded={openMemberMenuId === member.id} onClick={() => setOpenMemberMenuId((openId) => openId === member.id ? null : member.id)}>⋮</button>{openMemberMenuId === member.id && <div className="manager-member-menu-panel" role="menu">{member.role === 'player' ? <button type="button" role="menuitem" onClick={() => void changeMemberRole(member, 'manager')}>הפוך למנהל</button> : <button type="button" role="menuitem" onClick={() => void changeMemberRole(member, 'player')}>הסר הרשאת מנהל</button>}<button type="button" role="menuitem" className="danger-menu-item" onClick={() => void revokeApproval(member)}>הסר משתמש</button></div>}</div>}</div></div>) : <p className="empty-list">אין משתמשים מאושרים.</p>}
        </div>
        <div className="manager-section manager-section-attendance"><div className="list-heading"><h3>עדכון נוכחות</h3><span>משחקים אחרונים</span></div>
          {managerMatches.map((match) => {
            const canFinalizeNow = !registrationOpen && match.week_start <= nextSignupBoundary.weekStart
            return <div className="attendance-match" key={match.id}><h4>שבוע שמתחיל ב־{new Date(`${match.week_start}T12:00:00`).toLocaleDateString('he-IL')}</h4>{match.status === 'signup' && <div className="finalize-row"><span>{registrationOpen && openSignupWeek === match.week_start ? 'ההרשמה עדיין פתוחה' : canFinalizeNow ? 'ההרשמה נסגרה; אפשר לבצע בחירה ידנית' : 'ההרשמה נסגרה; בחירת ההרכב תתבצע במועד השבועי'}</span>{canFinalizeNow && <button className="approve-button" onClick={() => finalizeMatch(match.week_start)}>בחירת 15 שחקנים</button>}</div>}{match.players.map((player) => <div className="manager-row" key={player.id}><strong>{player.first} {player.last}</strong>{player.result === 'selected' ? <div className="manager-actions"><button className="approve-button" onClick={() => recordAttendance(match.id, player.id, true)}>הגיע</button><button className="reject-button" onClick={() => recordAttendance(match.id, player.id, false)}>לא הגיע</button></div> : <span className="player-stat">{player.result === 'attended' ? 'הגיע' : 'לא הגיע'}</span>}</div>)}</div>
          })}
          {!managerMatches.length && <p className="empty-list">לא נמצאו משחקים שממתינים לעדכון נוכחות.</p>}
        </div>
      </section>}

      {notice && <div className="notice" role="status"><span>{notice}</span><button aria-label="סגירה" onClick={() => setNotice('')}>×</button></div>}
      <footer className="footer"><span>כדורגל זה יותר ממשחק.</span><span>נפגשים על הדשא <b>·</b> כל שבוע</span></footer>

      {pendingSignupState !== null && <div className="modal-backdrop" role="presentation" onClick={() => setPendingSignupState(null)}>
        <section className="join-modal signup-confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="signup-confirm-title" aria-describedby="signup-confirm-description" onClick={(event) => event.stopPropagation()}>
          <span className="section-kicker">ניהול הרשמה</span><h2 id="signup-confirm-title">{pendingSignupState ? 'לפתוח את ההרשמה?' : 'לסגור את ההרשמה?'}</h2>
          <p id="signup-confirm-description">{pendingSignupState ? 'משתמשים מאושרים יוכלו להירשם למשחק השבועי.' : 'משתמשים לא יוכלו להירשם או לבטל את ההרשמה למשחק השבועי.'} בטוח שברצונך להמשיך?</p>
          <div className="signup-confirm-actions"><button className="button button-quiet signup-cancel" onClick={() => setPendingSignupState(null)} disabled={busy}>ביטול</button><button className={`button ${pendingSignupState ? 'button-primary' : 'signup-close-confirm'}`} onClick={() => void updateSignupState()} disabled={busy}>{busy ? 'מעדכן…' : pendingSignupState ? 'כן, לפתוח הרשמה' : 'כן, לסגור הרשמה'}</button></div>
        </section>
      </div>}

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
