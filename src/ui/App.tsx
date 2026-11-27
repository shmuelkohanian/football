import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

type Player = { id: string; first: string; last: string; attended: number; late: number; missed: number; registered: boolean; selectionRank?: number | null; signupTime?: string }
type Profile = { id: string; first_name: string; last_name: string; status: 'pending' | 'approved' | 'rejected'; role: 'player' | 'manager' }
type AttendanceStatus = 'attended' | 'late' | 'no_show' | 'excused'
type ManagerMatch = { id: string; week_start: string; status: string; players: Array<Player & { result: string; attendanceStatus: AttendanceStatus | null; goalsInput: string; assistsInput: string }> }
type LeaderboardRow = { player_id: string; first_name: string; last_name: string; total: number; place: number }
type LeaderboardSnapshot = { previous_ready: boolean; previous_has_data: boolean; current_has_data: boolean; current_month: string; previous_month: string; current_goals: LeaderboardRow[]; current_assists: LeaderboardRow[]; previous_goals: LeaderboardRow[]; previous_assists: LeaderboardRow[] }

function isValidStatInput(value: string) {
  return value === '' || (/^\d+$/.test(value) && Number(value) <= 14)
}

function formatWeekDate(week: string | null, offsetDays = 0) {
  if (!week) return ''
  const date = new Date(`${week}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date)
}

function formatMonthLabel(month: string | undefined) {
  if (!month) return 'טוען…'
  return new Intl.DateTimeFormat('he-IL', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${month}T12:00:00Z`))
}

function formatRelativeMonthLabel(now: Date, offset: number) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit' }).formatToParts(now)
  const year = Number(parts.find((part) => part.type === 'year')?.value)
  const month = Number(parts.find((part) => part.type === 'month')?.value)
  const date = new Date(Date.UTC(year, month - 1 + offset, 1, 12))
  return formatMonthLabel(date.toISOString().slice(0, 10))
}

const initialPlayers: Player[] = [
  { id: 'demo-1', first: 'איתי', last: 'כהן', attended: 2, late: 0, missed: 0, registered: true },
  { id: 'demo-2', first: 'נועם', last: 'לוי', attended: 4, late: 0, missed: 1, registered: false },
  { id: 'demo-3', first: 'דניאל', last: 'פרץ', attended: 1, late: 0, missed: 0, registered: true },
  { id: 'demo-4', first: 'עומר', last: 'מזרחי', attended: 3, late: 0, missed: 0, registered: false },
]
const FALLBACK_SIGNUP_CAPACITY = 15

function App() {
  const live = Boolean(supabase)
  const [now, setNow] = useState(() => new Date())
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [players, setPlayers] = useState(initialPlayers)
  const [registered, setRegistered] = useState(true)
  const [registrationOpen, setRegistrationOpen] = useState(true)
  const [signupCapacity, setSignupCapacity] = useState(FALLBACK_SIGNUP_CAPACITY)
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
  const [pendingMembers, setPendingMembers] = useState<Profile[]>([])
  const [approvedMembers, setApprovedMembers] = useState<Profile[]>([])
  const [managerMatches, setManagerMatches] = useState<ManagerMatch[]>([])
  const [showStats, setShowStats] = useState(false)
  const [leaderboards, setLeaderboards] = useState<LeaderboardSnapshot | null>(null)
  const [leaderboardsLoading, setLeaderboardsLoading] = useState(false)
  const [leaderboardsError, setLeaderboardsError] = useState(false)
  const [busy, setBusy] = useState(false)

  const registeredCount = useMemo(() => players.filter((player) => player.registered).length, [players])
  const selectedPlayers = useMemo(() => players.filter((player) => player.selectionRank != null && player.selectionRank <= signupCapacity).sort((a, b) => a.selectionRank! - b.selectionRank!), [players, signupCapacity])
  const additionalPlayers = useMemo(() => players.filter((player) => player.selectionRank != null && player.selectionRank > signupCapacity).sort((a, b) => a.selectionRank! - b.selectionRank!), [players, signupCapacity])
  const rankedOpenPlayers = useMemo(() => [...players].sort((a, b) => (a.selectionRank ?? Number.MAX_SAFE_INTEGER) - (b.selectionRank ?? Number.MAX_SAFE_INTEGER) || (a.signupTime ?? '').localeCompare(b.signupTime ?? '')), [players])
  const latestClosedMatch = useMemo(() => managerMatches[0]?.status !== 'signup' ? managerMatches[0] : undefined, [managerMatches])
  const nextSignupBoundary = useMemo(() => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now)
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday'))
    const hour = Number(value('hour'))
    const isOpen = (day === 0 && hour >= 9) || (day === 1 && hour < 9)
    const daysUntilBoundary = isOpen ? (day === 1 ? 0 : 1) : (7 - day) % 7
    const boundary = new Date(Date.UTC(Number(value('year')), Number(value('month')) - 1, Number(value('day')) + daysUntilBoundary, 9))
    const weekStart = new Date(Date.UTC(Number(value('year')), Number(value('month')) - 1, Number(value('day')) - day))
    if (day === 0 && hour < 9) weekStart.setUTCDate(weekStart.getUTCDate() - 7)
    const cycleWeekStart = `${weekStart.getUTCFullYear()}-${String(weekStart.getUTCMonth() + 1).padStart(2, '0')}-${String(weekStart.getUTCDate()).padStart(2, '0')}`
    const formattedDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(boundary)
    return { isOpen, isClosingHour: day === 1 && hour === 9, date: formattedDate, weekStart: cycleWeekStart }
  }, [now])
  const displayedSignupBoundary = useMemo(() => {
    if (registrationOpen && openSignupWeek) return { label: 'סגירת ההרשמה', date: formatWeekDate(openSignupWeek, 1) }
    if (!registrationOpen && nextSignupBoundary.isOpen) return { label: 'פתיחת הרשמה הבאה', date: formatWeekDate(nextSignupBoundary.weekStart, 7) }
    return { label: nextSignupBoundary.isOpen ? 'סגירת ההרשמה' : 'פתיחת הרשמה הבאה', date: nextSignupBoundary.date }
  }, [registrationOpen, openSignupWeek, nextSignupBoundary])
  const rosterWeek = registrationOpen && openSignupWeek ? openSignupWeek : nextSignupBoundary.weekStart

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (registrationOpen || !nextSignupBoundary.isClosingHour) return
    const timer = window.setTimeout(() => setRefreshKey((value) => value + 1), 10_000)
    return () => window.clearTimeout(timer)
  }, [registrationOpen, nextSignupBoundary.isClosingHour])

  useEffect(() => {
    if (!supabase) {
      setRegistrationOpen(nextSignupBoundary.isOpen)
      return
    }
    let active = true
    Promise.all([supabase.rpc('signup_week_for_now'), supabase.rpc('signup_capacity')]).then(([signupResponse, capacityResponse]) => {
      if (active && !signupResponse.error) {
        const week = signupResponse.data as string | null
        setOpenSignupWeek(week)
        setRegistrationOpen(Boolean(week))
      }
      if (active && !capacityResponse.error && typeof capacityResponse.data === 'number') setSignupCapacity(capacityResponse.data)
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
      const openResponse = await supabase!.rpc('signup_week_for_now')
      if (!active) return
      if (openResponse.error) {
        setNotice('לא הצלחנו לטעון את מצב ההרשמה כרגע.')
        return
      }
      const openWeek = openResponse.data as string | null
      setRegistrationOpen(Boolean(openWeek))
      setOpenSignupWeek(openWeek)
      const weekToLoad = openWeek ?? rosterWeek
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
        supabase!.from('player_recent_stats').select('player_id, attended_last_8, late_last_8, no_shows_last_8').in('player_id', ids),
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
          late: playerStats?.late_last_8 ?? 0,
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
  }, [user, refreshKey, nextSignupBoundary.isOpen, nextSignupBoundary.weekStart, rosterWeek])

  useEffect(() => {
    if (!supabase || !showManager || profile?.role !== 'manager' || profile.status !== 'approved') return
    let active = true
    async function loadManagerBoard() {
      const [pendingResponse, approvedResponse, matchesResponse] = await Promise.all([
        supabase!.from('profiles').select('id, first_name, last_name, status, role').eq('status', 'pending').order('created_at'),
        supabase!.from('profiles').select('id, first_name, last_name, status, role').eq('status', 'approved').order('first_name').order('last_name'),
        supabase!.from('matches').select('id, week_start, status').in('status', ['selected', 'completed']).order('week_start', { ascending: false }).limit(8),
      ])
      if (!active) return
      setPendingMembers((pendingResponse.data ?? []) as Profile[])
      setApprovedMembers((approvedResponse.data ?? []) as Profile[])
      const matches = matchesResponse.data ?? []
      const ids = matches.map((match) => match.id)
      if (!ids.length) { setManagerMatches([]); return }
      const { data: entries } = await supabase!.from('match_entries').select('match_id, player_id, result, selection_rank, attendance_status, goals, assists').in('match_id', ids).is('cancelled_at', null).not('selection_rank', 'is', null).order('selection_rank')
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
          const savedStatus = entry.attendance_status as AttendanceStatus | null
          const legacyStatus = entry.result === 'attended' || entry.result === 'no_show' ? entry.result as AttendanceStatus : null
          return name ? [{ id: entry.player_id, first: name.first_name, last: name.last_name, attended: 0, late: 0, missed: 0, registered: true, result: entry.result, attendanceStatus: savedStatus ?? legacyStatus, goalsInput: String(entry.goals ?? 0), assistsInput: String(entry.assists ?? 0) }] : []
        }),
      })))
    }
    void loadManagerBoard()
    return () => { active = false }
  }, [showManager, profile, refreshKey, signupCapacity, nextSignupBoundary.isOpen])

  useEffect(() => {
    if (!showStats || !supabase || profile?.status !== 'approved') return
    let active = true
    setLeaderboards(null)
    setLeaderboardsError(false)
    setLeaderboardsLoading(true)
    let timedOut = false
    const timeoutId = window.setTimeout(() => {
      timedOut = true
      if (active) {
        setLeaderboardsError(true)
        setLeaderboardsLoading(false)
      }
    }, 12_000)
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('get_personal_leaderboards')
        if (!active || timedOut) return
        if (error) throw error
        setLeaderboards(data as LeaderboardSnapshot | null)
      } catch {
        if (active && !timedOut) setLeaderboardsError(true)
      } finally {
        window.clearTimeout(timeoutId)
        if (active && !timedOut) setLeaderboardsLoading(false)
      }
    })()
    return () => { active = false; window.clearTimeout(timeoutId) }
  }, [showStats, profile, refreshKey])

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

  async function addAbsence(member: Profile) {
    if (!supabase || registrationOpen) return
    if (!window.confirm(`לסמן את ${member.first_name} ${member.last_name} כמי שנרשם ולא הגיע בהרשמה האחרונה שנסגרה?`)) return
    const { error } = await supabase.rpc('add_absence_for_closed_signup', { p_player_id: member.id })
    if (error) setNotice(error.message.includes('No eligible player') ? 'המשתמש לא נבחר בהרכב האחרון שנסגר.' : 'לא הצלחנו להוסיף את ההיעדרות.')
    else { setOpenMemberMenuId(null); setNotice(`ההיעדרות של ${member.first_name} ${member.last_name} נשמרה להרשמה האחרונה שנסגרה.`); setRefreshKey((value) => value + 1) }
  }

  function markAttendance(matchId: string, playerId: string, attendanceStatus: AttendanceStatus) {
    setManagerMatches((current) => current.map((match) => match.id === matchId
      ? { ...match, players: match.players.map((player) => player.id === playerId ? { ...player, attendanceStatus } : player) }
      : match))
  }

  function markAttendanceStat(matchId: string, playerId: string, field: 'goalsInput' | 'assistsInput', value: string) {
    setManagerMatches((current) => current.map((match) => match.id === matchId
      ? { ...match, players: match.players.map((player) => player.id === playerId ? { ...player, [field]: value } : player) }
      : match))
  }

  async function saveAttendance(match: ManagerMatch) {
    if (!supabase || match.players.length === 0 || match.players.some((player) => player.attendanceStatus === null || ((player.attendanceStatus === 'attended' || player.attendanceStatus === 'late') && (!isValidStatInput(player.goalsInput) || !isValidStatInput(player.assistsInput))))) return
    setBusy(true)
    const { error } = await supabase.rpc('save_match_attendance', {
      p_match_id: match.id,
      p_attendance: match.players.map((player) => ({
        player_id: player.id,
        status: player.attendanceStatus,
        goals: player.attendanceStatus === 'attended' || player.attendanceStatus === 'late' ? Number(player.goalsInput || 0) : 0,
        assists: player.attendanceStatus === 'attended' || player.attendanceStatus === 'late' ? Number(player.assistsInput || 0) : 0,
      })),
    })
    setBusy(false)
    if (error) setNotice('לא הצלחנו לשמור את הנוכחות. נסו שוב.')
    else { setNotice(`הנוכחות למשחק מ־${formatWeekDate(match.week_start)} נשמרה.`); setRefreshKey((value) => value + 1) }
  }

  const userIsRegistered = live ? Boolean(user && registered) : registered
  const displayedPlayerCount = registrationOpen ? registeredCount : selectedPlayers.length
  const canSignUp = !live || (user !== null && profile?.status === 'approved' && registrationOpen)
  async function copyWeeklyLineup() {
    const rankedClosedPlayers = [...players].filter((player) => player.selectionRank != null).sort((a, b) => a.selectionRank! - b.selectionRank!)
    const selected = rankedClosedPlayers.filter((player) => player.selectionRank! <= signupCapacity)
    const sixteenth = rankedClosedPlayers.find((player) => player.selectionRank! === signupCapacity + 1)
    const waiting = rankedClosedPlayers.filter((player) => player.selectionRank! > signupCapacity + 1)
    const numberedNames = (items: Player[]) => items.map((player, index) => `${index + 1}. ${player.first} ${player.last}`)
    const lines = [
      '*ההרכב שנבחר:*',
      ...numberedNames(selected),
      '',
      '*שחקן 16:*',
      sixteenth ? `${sixteenth.first} ${sixteenth.last}` : 'אין',
      '',
      '*רשימת המתנה:*',
      ...(waiting.length ? numberedNames(waiting) : ['אין']),
    ].join('\n')
    try {
      await navigator.clipboard.writeText(lines)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = lines
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.append(textarea)
      textarea.select()
      const copied = document.execCommand('copy')
      textarea.remove()
      if (!copied) {
        setNotice('לא הצלחנו להעתיק את ההרכב.')
        return
      }
    }
    setNotice('ההרכב השבועי הועתק.')
  }
  const attendanceValid = (match: ManagerMatch) => match.players.length > 0 && match.players.every((player) =>
    player.attendanceStatus !== null && ((player.attendanceStatus !== 'attended' && player.attendanceStatus !== 'late') || (isValidStatInput(player.goalsInput) && isValidStatInput(player.assistsInput))))
  const renderLeaderboard = (title: string, rows: LeaderboardRow[], metric: 'goals' | 'assists') => (
    <section className="personal-stats-card">
      <div className="personal-stats-card-heading"><span className="personal-stats-icon">{metric === 'goals' ? '⚽' : '✦'}</span><h3>{title}</h3></div>
      {rows.length ? <ol className="personal-stats-list">{rows.map((row) => <li key={row.player_id}><span className="personal-stats-rank">{String(row.place).padStart(2, '0')}</span><strong>{row.first_name} {row.last_name}</strong><span className="personal-stats-total">{row.total} {metric === 'goals' ? 'שערים' : 'בישולים'}</span></li>)}</ol> : <p className="personal-stats-empty">עדיין אין נתונים להצגה.</p>}
    </section>
  )

  return (
    <main className="page-shell">
      <div className="preview-note"><span className="preview-dot" />{live ? 'מחובר למסד הנתונים · אזור ההרשמה פעיל' : 'תצוגה מקדימה · ההרשמות נשמרות רק בתצוגה הזו'}</div>
      <header className="topbar">
        <a className="brand" href="#home" aria-label="מועדון הכדורגל — עמוד הבית">
          <span className="brand-mark" aria-hidden="true">⚽</span>
          <span><strong>המשחק השבועי</strong><small>מועדון הכדורגל שלנו</small></span>
        </a>
        <div className="top-actions">
          {profile?.status === 'approved' && <button className="button button-quiet stats-toggle" onClick={() => { setShowStats((open) => !open); setShowManager(false) }}>{showStats ? 'עמוד ההרשמה' : 'סטטיסטיקות אישיות'}</button>}
          {profile?.role === 'manager' && profile.status === 'approved' && <button className="button button-quiet manager-toggle" onClick={() => { setShowManager((open) => !open); setShowStats(false) }}>{showManager ? 'עמוד ההרשמה' : 'לוח מנהל'}</button>}
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

      {!showManager && !showStats && <>
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
          <div className="hero-art hero-video-frame" role="group" aria-label="קטע משחק כדורגל">
            <video className="hero-video" autoPlay muted loop playsInline preload="metadata" aria-label="שחקנים מכדררים ומנסים להבקיע במשחק כדורגל">
              <source src="/football-highlights.mp4" type="video/mp4" />
            </video>
            <div className="hero-video-shade" aria-hidden="true" />
            <div className="art-caption"><span>01 / 08</span><span>שומרים על המסורת</span></div>
          </div>
        </section>

        <section className="signup-panel" aria-label="מצב ההרשמה">
          <div className="signup-summary">
            <div><span className="section-kicker">ההרשמה השבועית</span><h2>{registrationOpen ? 'מי עולה למגרש?' : `ההרכב השבועי ${formatWeekDate(rosterWeek, 1)}`}</h2></div>
            <div className="spots"><strong>{String(displayedPlayerCount).padStart(2, '0')}</strong><span>{registrationOpen ? 'נרשמו' : 'נבחרו'}<br />עד עכשיו</span><i /> <span className="spots-total">{signupCapacity}<br />מקומות בהרכב</span></div>
          </div>
          {!registrationOpen && selectedPlayers.length > 0 && <button type="button" className="copy-roster-button" onClick={() => void copyWeeklyLineup()}>העתק הרכב שבועי</button>}
          <div className="progress-track"><span style={{ width: `${Math.min(100, displayedPlayerCount / signupCapacity * 100)}%` }} /></div>
          <div className="list-heading"><h3>{registrationOpen ? 'העדיפות כרגע' : 'ההרכב שנבחר'}</h3><span>{registrationOpen ? 'דירוג לפי היסטוריית הגעה והיעדרות · שוויון יוכרע בהגרלה בסגירה' : 'ההרכב והמשך רשימת הנרשמים'}</span></div>
          <div className="player-list">
            {(registrationOpen ? rankedOpenPlayers : selectedPlayers).map((player, index) => (
              <div className="player-row" key={player.id}>
                <span className="player-number">{registrationOpen && index > 0 && player.selectionRank != null && player.selectionRank === rankedOpenPlayers[index - 1]?.selectionRank ? '—' : String(registrationOpen ? (player.selectionRank ?? index + 1) : index + 1).padStart(2, '0')}</span><span className="avatar">{player.first.slice(0, 1)}</span>
                <strong>{player.first} {player.last}</strong><span className="player-stat">{player.attended} הגעות · {player.late} איחורים · {player.missed} הברזות</span>
                {player.id === user?.id && <span className="you-badge">אתה</span>}
              </div>
            ))}
            {!registrationOpen && additionalPlayers.length > 0 && <div className="player-list-divider"><span>נרשמו ולא נבחרו להרכב</span></div>}
            {!registrationOpen && additionalPlayers.map((player, index) => (
              <div className="player-row" key={player.id}>
                <span className="player-number">{String(selectedPlayers.length + index + 1).padStart(2, '0')}</span><span className="avatar">{player.first.slice(0, 1)}</span>
                <strong>{player.first} {player.last}</strong><span className="player-stat">{player.attended} הגעות · {player.late} איחורים · {player.missed} הברזות</span>
                {player.id === user?.id && <span className="you-badge">אתה</span>}
              </div>
            ))}
            {registeredCount === 0 && <p className="empty-list">{live && !user ? 'התחברו כדי לראות את רשימת הנרשמים.' : registrationOpen ? 'עוד לא נרשמו השבוע. אולי תהיה הראשון?' : 'הבחירה השבועית מתבצעת. הרשימה תוצג כאן.'}</p>}
          </div>
          <div className="selection-note"><span className="info-mark">i</span><p>כל השחקנים יכולים להירשם עד סגירת ההרשמה. אז ייקבעו {signupCapacity} שחקני ההרכב לפי היסטוריית ההשתתפות בשמונת השבועות האחרונים, ושאר הנרשמים יוצגו בהמשך הרשימה.</p></div>
        </section>
      </>}

      {showStats && <section className="personal-stats-panel">
        <span className="section-kicker">המספרים של המועדון</span><h2>סטטיסטיקות אישיות</h2>
        <p className="personal-stats-intro">הטבלאות מתעדכנות לאחר שמנהל שומר את עדכון הנוכחות של מפגש.</p>
        <div className="personal-stats-period"><span>החודש הקודם</span><h3>{leaderboards ? formatMonthLabel(leaderboards.previous_month) : formatRelativeMonthLabel(now, -1)}</h3></div>
        {leaderboardsLoading ? <p className="personal-stats-empty">טוען את טבלאות המובילים…</p> : leaderboardsError ? <p className="personal-stats-empty">עדיין אין נתונים.</p> : leaderboards?.previous_ready && leaderboards.previous_has_data ? <div className="personal-stats-grid">{renderLeaderboard('מלך השערים', leaderboards.previous_goals, 'goals')}{renderLeaderboard('מלך הבישולים', leaderboards.previous_assists, 'assists')}</div> : <p className="personal-stats-empty">עדיין אין נתונים.</p>}
        <div className="personal-stats-period personal-stats-period-current"><span>החודש הנוכחי</span><h3>{leaderboards ? formatMonthLabel(leaderboards.current_month) : formatRelativeMonthLabel(now, 0)}</h3></div>
        {leaderboardsLoading ? <p className="personal-stats-empty">טוען את טבלאות המובילים…</p> : leaderboardsError ? <p className="personal-stats-empty">עדיין אין נתונים.</p> : leaderboards?.current_has_data ? <div className="personal-stats-grid">{renderLeaderboard('מלך השערים', leaderboards.current_goals, 'goals')}{renderLeaderboard('מלך הבישולים', leaderboards.current_assists, 'assists')}</div> : <p className="personal-stats-empty">עדיין אין נתונים.</p>}
      </section>}

      {showManager && <section className="manager-panel">
        <span className="section-kicker">ניהול המועדון</span><h2>לוח מנהל</h2>
        <div className="manager-section manager-section-attendance"><div className="list-heading"><h3>עדכון נוכחות</h3><span>משחקים סגורים שממתינים לסימון ולשמירה</span></div>
          {managerMatches.some((match) => match.status === 'selected') ? managerMatches.filter((match) => match.status === 'selected').map((match) => {
            const allMarked = attendanceValid(match)
            return <div className="attendance-match" key={match.id}><h4>{formatWeekDate(match.week_start)} · הנוכחות טרם נשמרה</h4>
              {match.players.length ? <>
                {match.players.map((player) => {
                  const statsVisible = player.attendanceStatus === 'attended' || player.attendanceStatus === 'late'
                  const goalsInvalid = statsVisible && !isValidStatInput(player.goalsInput)
                  const assistsInvalid = statsVisible && !isValidStatInput(player.assistsInput)
                  return <div className="attendance-player" key={player.id}>
                    <div className="manager-row attendance-row"><strong>{player.first} {player.last}</strong><div className="attendance-actions">
                      <button type="button" className={player.attendanceStatus === 'attended' ? 'attendance-choice attendance-attended attendance-active' : 'attendance-choice attendance-attended'} onClick={() => markAttendance(match.id, player.id, 'attended')} disabled={busy} aria-pressed={player.attendanceStatus === 'attended'}>הגיע</button>
                      <button type="button" className={player.attendanceStatus === 'late' ? 'attendance-choice attendance-late attendance-active' : 'attendance-choice attendance-late'} onClick={() => markAttendance(match.id, player.id, 'late')} disabled={busy} aria-pressed={player.attendanceStatus === 'late'}>איחר</button>
                      <button type="button" className={player.attendanceStatus === 'no_show' ? 'attendance-choice attendance-no-show attendance-active' : 'attendance-choice attendance-no-show'} onClick={() => markAttendance(match.id, player.id, 'no_show')} disabled={busy} aria-pressed={player.attendanceStatus === 'no_show'}>הבריז</button>
                      <button type="button" className={player.attendanceStatus === 'excused' ? 'attendance-choice attendance-excused attendance-active' : 'attendance-choice attendance-excused'} onClick={() => markAttendance(match.id, player.id, 'excused')} disabled={busy} aria-pressed={player.attendanceStatus === 'excused'}>חיסור מוצדק</button>
                    </div></div>
                    {statsVisible && <div className="attendance-stats-row">
                      <span className="attendance-stats-caption">נתוני המשחק</span>
                      <label className={goalsInvalid ? 'attendance-stat-field attendance-stat-invalid' : 'attendance-stat-field'}><span>שערים</span><input type="number" inputMode="numeric" min="0" max="14" step="1" value={player.goalsInput} onFocus={(event) => { if (event.currentTarget.value === '0') markAttendanceStat(match.id, player.id, 'goalsInput', '') }} onChange={(event) => markAttendanceStat(match.id, player.id, 'goalsInput', event.currentTarget.value)} disabled={busy} aria-label={`שערים של ${player.first} ${player.last}`} aria-invalid={goalsInvalid} /><small>{goalsInvalid ? 'יש להזין מספר שלם בין 0 ל־14' : '0–14'}</small></label>
                      <label className={assistsInvalid ? 'attendance-stat-field attendance-stat-invalid' : 'attendance-stat-field'}><span>בישולים</span><input type="number" inputMode="numeric" min="0" max="14" step="1" value={player.assistsInput} onFocus={(event) => { if (event.currentTarget.value === '0') markAttendanceStat(match.id, player.id, 'assistsInput', '') }} onChange={(event) => markAttendanceStat(match.id, player.id, 'assistsInput', event.currentTarget.value)} disabled={busy} aria-label={`בישולים של ${player.first} ${player.last}`} aria-invalid={assistsInvalid} /><small>{assistsInvalid ? 'יש להזין מספר שלם בין 0 ל־14' : '0–14'}</small></label>
                    </div>}
                  </div>
                })}
                <button type="button" className="approve-button attendance-save" onClick={() => void saveAttendance(match)} disabled={!allMarked || busy}>שמור נוכחות</button>
              </> : <p className="empty-list">לא נמצאו נרשמים למשחק הזה.</p>}
            </div>
          }) : <p className="empty-list">אין משחקים שממתינים לעדכון נוכחות.</p>}
        </div>
        <div className="manager-section manager-section-pending"><div className="list-heading"><h3>בקשות הצטרפות ממתינות</h3><span>{pendingMembers.length} בקשות</span></div>
          {pendingMembers.length ? pendingMembers.map((member) => <div className="manager-row" key={member.id}><div><strong>{member.first_name} {member.last_name}</strong><small>נרשם במתנ״ס</small></div><div className="manager-actions"><button className="approve-button" onClick={() => approveMember(member.id, true)}>אישור</button><button className="reject-button" onClick={() => approveMember(member.id, false)}>דחייה</button></div></div>) : <p className="empty-list">אין בקשות שממתינות לאישור.</p>}
        </div>
        <div className="manager-section manager-section-approved"><div className="list-heading"><h3>משתמשים מאושרים</h3><span>{approvedMembers.length} משתמשים</span></div>
          {approvedMembers.length ? approvedMembers.map((member) => {
            const canAddAbsence = !registrationOpen && latestClosedMatch?.players.some((player) => player.id === member.id && (player.result === 'selected' || player.result === 'attended'))
            return <div className="manager-row" key={member.id}><strong>{member.first_name} {member.last_name}</strong><div className="manager-member-actions">{member.role === 'manager' && <span className="manager-role-badge">מנהל</span>}{(member.id !== user?.id || canAddAbsence) && <div className="manager-member-menu"><button type="button" className="manager-member-menu-trigger" aria-label={`אפשרויות עבור ${member.first_name} ${member.last_name}`} aria-haspopup="menu" aria-expanded={openMemberMenuId === member.id} onClick={() => setOpenMemberMenuId((openId) => openId === member.id ? null : member.id)}>⋮</button>{openMemberMenuId === member.id && <div className="manager-member-menu-panel" role="menu">{member.id !== user?.id && (member.role === 'player' ? <button type="button" role="menuitem" onClick={() => void changeMemberRole(member, 'manager')}>הפוך למנהל</button> : <button type="button" role="menuitem" onClick={() => void changeMemberRole(member, 'player')}>הסר הרשאת מנהל</button>)}{canAddAbsence && <button type="button" role="menuitem" onClick={() => void addAbsence(member)}>הוסף היעדרות</button>}{member.id !== user?.id && <button type="button" role="menuitem" className="danger-menu-item" onClick={() => void revokeApproval(member)}>הסר משתמש</button>}</div>}</div>}</div></div>
          }) : <p className="empty-list">אין משתמשים מאושרים.</p>}
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
