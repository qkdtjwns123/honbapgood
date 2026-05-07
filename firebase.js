// firebase.js — 댓글 + 매칭 + 나가기 알림 + 패널티/이용제한(거절자만) + 좋아요(게시글/댓글) + 매칭 스코어
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import {
    getAuth, onAuthStateChanged, signInAnonymously, signOut,
    signInWithEmailAndPassword, createUserWithEmailAndPassword,
    sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
    updatePassword, fetchSignInMethodsForEmail
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
    getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
    collection, query, where, orderBy, limit, getDocs, onSnapshot, runTransaction,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

// ────────────────────── 초기화 ──────────────────────
const __cfg = (typeof window !== "undefined" && window.firebaseConfig)
    ? window.firebaseConfig
    : {
        apiKey: "AIzaSyB0TUXQpzZIy0v2gbLOC343Jx_Lv51EQvw",
        authDomain: "honbap-paring.firebaseapp.com",
        projectId: "honbap-paring",
        storageBucket: "honbap-paring.firebasestorage.app",
        messagingSenderId: "375771626039",
        appId: "1:375771626039:web:03868631de56225cf49db2",
    };

if (!__cfg?.apiKey) {
    throw new Error("[firebase.js] firebaseConfig.apiKey가 비었습니다.");
}

const app = initializeApp(__cfg);
const auth = getAuth(app);
const db = getFirestore(app);

// 관리자
const __admins = (Array.isArray(window.ADMIN_EMAILS) ? window.ADMIN_EMAILS : [])
    .map(s => String(s || "").toLowerCase());
const isAdminEmail = (e) => __admins.includes(String(e || "").toLowerCase());
const isAdmin = () => __admins.includes((auth.currentUser?.email || "").toLowerCase());

// ────────────────────── 프로필 공통 ──────────────────────
const my = {
    get uid() {
        return auth?.currentUser?.uid || null;
    },

    async requireAuth() {
        if (auth.currentUser) return auth.currentUser;

        const waited = await new Promise(res => {
            let done = false;
            const t = setTimeout(() => {
                if (!done) { done = true; res(null); }
            }, 1500);

            const un = onAuthStateChanged(auth, u => {
                if (!done && u) {
                    done = true;
                    clearTimeout(t);
                    un();
                    res(u);
                }
            });
        });

        if (waited) return waited;

        await signInAnonymously(auth);
        return new Promise(res => {
            const un = onAuthStateChanged(auth, u => {
                if (u) { un(); res(u); }
            });
        });
    },

    async logout() {
        await signOut(auth);
    },

    async nowProfile() {
        await my.requireAuth();
        const snap = await getDoc(doc(db, "profiles", my.uid));
        return snap.exists() ? snap.data() : null;
    },

    async saveProfile(p) {
        await my.requireAuth();
        const u = auth.currentUser;

        const payload = {
            email: u?.email ?? null,
            year: p.year ?? null,
            age: p.age ?? null,
            gender: p.gender ?? null,
            major: p.major ?? null,
            mbti: p.mbti ?? null,
            nickname: (p.nickname ?? p.nick ?? "").trim() || null,
            content: (p.content ?? p.consume ?? "").trim() || null,
            freeText: (p.freeText ?? "").trim(),
            isBot: !!p.isBot,
            penaltyScore: p.penaltyScore ?? 0,
            penaltyUntil: p.penaltyUntil ?? null,
            honbapTemp: p.honbapTemp ?? 50,
            updatedAt: serverTimestamp(),
        };

        if (payload.nickname) {
            const ok = await checkNicknameAvailable(payload.nickname);
            if (!ok) {
                throw new Error("이미 사용 중인 닉네임입니다.");
            }
        }

        await setDoc(doc(db, "profiles", my.uid), payload, { merge: true });
    }
};

// ────────────────────── 로그인/회원가입 ──────────────────────
async function loginWithEmailPassword(email, pw) {
    const cred = await signInWithEmailAndPassword(auth, email, pw);
    return cred.user;
}
async function signUpWithEmailPassword(email, pw) {
    const cred = await createUserWithEmailAndPassword(auth, email, pw);
    return cred.user;
}

const KW_EMAIL_RE = /@kw\.ac\.kr$/i;
const _assertKwEmail = (e) => {
    if (!e || !KW_EMAIL_RE.test(e)) {
        throw new Error("광운대 이메일(@kw.ac.kr)만 사용 가능합니다.");
    }
};

const _actionCodeSettings = () => {
    if (typeof window === "undefined") {
        return { url: "http://localhost/signup.html", handleCodeInApp: true };
    }
    const url = new URL("signup.html", window.location.href).href;
    return { url, handleCodeInApp: true };
};

async function sendEmailLink(email) {
    const e = (email || "").trim();
    _assertKwEmail(e);

    let methods = [];
    try {
        methods = await fetchSignInMethodsForEmail(auth, e);
    } catch (err) {
        console.warn("Auth check failed:", err);
    }
    if (methods && methods.length > 0) {
        throw new Error("이미 가입된 메일입니다.");
    }

    await my.requireAuth();
    const q = query(collection(db, "profiles"), where("email", "==", e), limit(1));
    const ss = await getDocs(q);
    if (!ss.empty) {
        throw new Error("이미 가입된 메일입니다.");
    }

    await sendSignInLinkToEmail(auth, e, _actionCodeSettings());
    try { localStorage.setItem("signup_email", e); } catch { }
    return true;
}

async function handleEmailLinkIfPresent() {
    if (!isSignInWithEmailLink(auth, location.href)) {
        return { consumed: false, email: null };
    }
    let email = null;
    try { email = localStorage.getItem("signup_email"); } catch { }
    if (!email) throw new Error("인증 시작 이메일을 찾을 수 없습니다.");

    const cred = await signInWithEmailLink(auth, email, location.href);
    return { consumed: true, email: cred.user.email || email };
}

async function setPasswordForCurrentUser(pw) {
    if (!auth.currentUser) throw new Error("로그인이 필요합니다.");
    if (typeof pw !== "string" || pw.length < 8) {
        throw new Error("비밀번호는 8자 이상이어야 합니다.");
    }
    await updatePassword(auth.currentUser, pw);
    return true;
}

// ────────────────────── 닉네임 중복 체크 ──────────────────────
async function checkNicknameAvailable(nickname) {
    await my.requireAuth();
    const nick = (nickname || "").trim();
    if (!nick) return true;

    const qy = query(
        collection(db, "profiles"),
        where("nickname", "==", nick),
        limit(5)
    );
    const ss = await getDocs(qy);
    if (ss.empty) return true;

    const me = my.uid;
    const someoneElse = ss.docs.some(d => d.id !== me);
    return !someoneElse;
}

// ────────────────────── 커뮤니티: 게시글/댓글/좋아요 ──────────────────────
async function createPost({ title, body, anonymous = false }) {
    await my.requireAuth();
    const u = auth.currentUser;

    let authorDisplay = "익명";
    if (!anonymous) {
        const prof = await my.nowProfile().catch(() => null);
        const nick = (prof?.nickname || "").trim();
        if (nick) authorDisplay = nick;
        else if (u?.email) authorDisplay = (u.email.split("@")[0] || "익명");
    }

    await addDoc(collection(db, "posts"), {
        title: title ?? "",
        body: body ?? "",
        authorUid: u.uid,
        authorEmail: u.email ?? null,
        authorDisplay,
        isAnonymous: !!anonymous,
        createdAt: serverTimestamp()
    });
}

async function listPosts({ take = 30 } = {}) {
    try {
        const qy = query(
            collection(db, "posts"),
            orderBy("createdAt", "desc"),
            limit(take)
        );
        const ss = await getDocs(qy);
        return ss.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch {
        return [];
    }
}

async function updatePost(postId, { title, body }) {
    await my.requireAuth();
    if (!postId) throw new Error("postId가 필요합니다.");

    const ref = doc(db, "posts", postId);
    const s = await getDoc(ref);
    if (!s.exists()) throw new Error("post not found");

    const p = s.data();
    if (!(isAdmin() || p.authorUid === my.uid)) {
        throw new Error("권한이 없습니다.");
    }

    const patch = {};
    if (typeof title === "string") patch.title = title;
    if (typeof body === "string") patch.body = body;
    patch.updatedAt = serverTimestamp();

    await updateDoc(ref, patch);
}

async function deletePost(postId) {
    await my.requireAuth();
    if (!postId) throw new Error("postId가 필요합니다.");

    const ref = doc(db, "posts", postId);
    const s = await getDoc(ref);
    if (!s.exists()) return;

    const p = s.data();
    if (!(isAdmin() || p.authorUid === my.uid)) {
        throw new Error("권한이 없습니다.");
    }
    await deleteDoc(ref);
}

function onLikeCount(postId, cb) {
    const qy = collection(db, "posts", postId, "likes");
    return onSnapshot(qy, ss => cb(ss.size));
}

async function togglePostLike(postId) {
    if (!postId) throw new Error("postId가 필요합니다.");
    await my.requireAuth();
    const uid = my.uid;
    const ref = doc(db, "posts", postId, "likes", uid);
    const s = await getDoc(ref);
    if (s.exists()) {
        await deleteDoc(ref);
    } else {
        await setDoc(ref, { uid, createdAt: serverTimestamp() });
    }
}

async function listComments(postId, { take = 50 } = {}) {
    if (!postId) throw new Error("postId가 필요합니다.");
    await my.requireAuth();
    try {
        const qy = query(
            collection(db, "posts", postId, "comments"),
            orderBy("createdAt", "asc"),
            limit(take)
        );
        const ss = await getDocs(qy);
        return ss.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch {
        return [];
    }
}

async function addComment(postId, { text, anonymous = false }) {
    if (!postId) throw new Error("postId가 필요합니다.");
    await my.requireAuth();
    const u = auth.currentUser;

    let authorDisplay = "익명";
    if (!anonymous) {
        try {
            const prof = await my.nowProfile().catch(() => null);
            const nick = (prof?.nickname || "").trim();
            if (nick) authorDisplay = nick;
            else if (u?.email) authorDisplay = (u.email.split("@")[0] || "익명");
        } catch { }
    }

    await addDoc(collection(db, "posts", postId, "comments"), {
        text: String(text ?? ""),
        authorUid: u?.uid ?? null,
        authorEmail: u?.email ?? null,
        authorDisplay,
        isAnonymous: !!anonymous,
        createdAt: serverTimestamp()
    });
}

async function deleteComment(postId, commentId) {
    if (!postId || !commentId) throw new Error("postId/commentId가 필요합니다.");
    await my.requireAuth();

    const ref = doc(db, "posts", postId, "comments", commentId);
    const s = await getDoc(ref);
    if (!s.exists()) return;

    const c = s.data();
    const me = my.uid;
    const myEmail = (auth.currentUser?.email || "").toLowerCase();
    const isOwner =
        (c.authorUid === me) ||
        ((c.authorEmail || "").toLowerCase() === myEmail);

    if (!(isAdmin() || isOwner)) {
        throw new Error("권한이 없습니다.");
    }
    await deleteDoc(ref);
}

function onCommentLikeCount(postId, commentId, cb) {
    if (!postId || !commentId) return () => { };
    const qy = collection(db, "posts", postId, "comments", commentId, "likes");
    return onSnapshot(qy, ss => cb(ss.size));
}

async function toggleCommentLike(postId, commentId) {
    if (!postId || !commentId) throw new Error("postId/commentId가 필요합니다.");
    await my.requireAuth();
    const uid = my.uid;
    const ref = doc(db, "posts", postId, "comments", commentId, "likes", uid);
    const s = await getDoc(ref);
    if (s.exists()) {
        await deleteDoc(ref);
    } else {
        await setDoc(ref, { uid, createdAt: serverTimestamp() });
    }
}

// ────────────────────── 신고 ──────────────────────
async function reportUser({ targetUid, targetEmail, reason, context = "chat", roomId = null }) {
    await my.requireAuth();
    if (!targetUid && !targetEmail) throw new Error("신고 대상 정보가 없습니다.");
    if (!reason) throw new Error("신고 사유를 입력해주세요.");

    await addDoc(collection(db, "reports"), {
        reporterUid: my.uid,
        reporterEmail: auth.currentUser?.email ?? null,
        targetUid: targetUid ?? null,
        targetEmail: targetEmail ?? null,
        reason: String(reason).trim(),
        context,
        roomId: roomId ?? null,
        status: "pending",
        createdAt: serverTimestamp()
    });
}

// ────────────────────── 패널티 / 이용 제한 ──────────────────────
async function _checkBanOrThrow() {
    await my.requireAuth();
    const s = await getDoc(doc(db, "profiles", my.uid));
    const p = s.exists() ? s.data() : {};

    const until = p?.penaltyUntil?.toDate?.()
        ? p.penaltyUntil.toDate()
        : (p?.penaltyUntil || null);

    if (until && until.getTime() > Date.now()) {
        const mins = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60000));
        throw new Error(`패널티 5회 누적으로 1시간 동안 이용이 제한됩니다. 남은 시간: 약 ${mins}분 후 다시 시도하세요.`);
    }
}

async function applyPenalty() {
    await my.requireAuth();
    const ref = doc(db, "profiles", my.uid);
    const BAN_AFTER = 5;
    const BAN_MS = 60 * 60 * 1000;

    await runTransaction(db, async tx => {
        const s = await tx.get(ref);
        const p = s.exists() ? s.data() : {};
        const cur = Number(p.penaltyScore || 0);
        const next = cur + 1;

        if (next >= BAN_AFTER) {
            const until = new Date(Date.now() + BAN_MS);
            tx.set(ref, {
                penaltyScore: 0,
                penaltyUntil: until,
                updatedAt: serverTimestamp()
            }, { merge: true });
        } else {
            tx.set(ref, {
                penaltyScore: next,
                updatedAt: serverTimestamp()
            }, { merge: true });
        }
    });
}

// ────────────────────── 매칭 스코어(별) ──────────────────────
async function addMatchSuccess() {
    await my.requireAuth();
    const ref = doc(db, "profiles", my.uid);
    let result = { matchCount: 0, matchStars: 0, rewarded: false };

    await runTransaction(db, async tx => {
        const s = await tx.get(ref);
        const p = s.exists() ? s.data() : {};
        const curCount = Number(p.matchCount || 0);
        const curStarsRaw = Number(p.matchStars || 0);
        const curStars = Number.isFinite(curStarsRaw) && curStarsRaw > 0 ? curStarsRaw : 0;

        const nextCount = curCount + 1;
        const maxStars = 3;
        const nextStars = Math.min(maxStars, Math.floor(nextCount / 3));
        const rewarded = (nextStars >= maxStars && curStars < maxStars);

        tx.set(ref, {
            matchCount: nextCount,
            matchStars: nextStars,
            updatedAt: serverTimestamp()
        }, { merge: true });

        result = { matchCount: nextCount, matchStars: nextStars, rewarded };
    });

    return result;
}

async function resetMatchScore() {
    await my.requireAuth();
    const ref = doc(db, "profiles", my.uid);
    await setDoc(ref, {
        matchCount: 0,
        matchStars: 0,
        updatedAt: serverTimestamp()
    }, { merge: true });
}

// ────────────────────── 매칭 / 방 생성 ──────────────────────
const MATCH_TIMEOUT_MS = 45000;
const ONLINE_WINDOW_MS = 90000;

async function leaveQueueByUid(uid) {
    const qy = query(collection(db, "matchQueue"), where("uid", "==", uid));
    const ss = await getDocs(qy);
    await Promise.all(ss.docs.map(d => deleteDoc(d.ref)));
}

async function enterQueue(options) {
    await my.requireAuth();
    const prof = await my.nowProfile() || {};

    const ref = doc(collection(db, "matchQueue"));
    await setDoc(ref, {
        uid: my.uid,
        email: auth.currentUser.email ?? null,
        createdAt: serverTimestamp(),
        lastActive: serverTimestamp(),
        status: "waiting",
        pref: {
            year: prof.year ?? null,
            age: prof.age ?? null,
            gender: prof.gender ?? null,
            major: prof.major ?? null,
            freeText: prof.freeText ?? "",
            ...options
        },
        isBot: !!prof.isBot,
        roomId: null,
    });

    return ref.id;
}

async function findOpponent(myDocId) {
    const myRef = doc(db, "matchQueue", myDocId);
    const md = await getDoc(myRef);
    if (!md.exists()) throw new Error("대기열 문서가 없어요.");
    const me = md.data();

    const qy = query(
        collection(db, "matchQueue"),
        where("status", "==", "waiting"),
        orderBy("createdAt", "asc"),
        limit(25)
    );
    const snaps = await getDocs(qy);
    const now = Date.now();

    const freeOverlapCheck = (_A, other) => {
        if (!me.pref?.freeOverlap) return true;
        const clean = s => (s || "").replace(/\s/g, "");
        const a = clean(me.pref?.freeText);
        const b = clean(other?.pref?.freeText);
        if (!a || !b) return false;
        const days = ["월", "화", "수", "목", "금", "토", "일"];
        return days.some(ch => a.includes(ch) && b.includes(ch));
    };

    for (const d of snaps.docs) {
        if (d.id === myDocId) continue;
        const you = d.data();
        if (you.uid === me.uid) continue;
        if (you.status !== "waiting") continue;

        if (me.pref?.onlineOnly) {
            const last = (you.lastActive?.toDate?.() || new Date(0)).getTime();
            if (now - last > ONLINE_WINDOW_MS) continue;
        }

        const same = (a, b) => (a != null && b != null && a === b);

        if (me.pref?.yearSame && !same(me.pref?.year, you.pref?.year)) continue;
        if (me.pref?.majorSame && !same(me.pref?.major, you.pref?.major)) continue;
        if (me.pref?.ageSame && !same(me.pref?.age, you.pref?.age)) continue;
        if (me.pref?.genderSame && !same(me.pref?.gender, you.pref?.gender)) continue;

        if (!freeOverlapCheck(me.pref?.freeText, you)) continue;

        return { id: d.id, you };
    }
    return null;
}

async function createRoomAndInvite(myDocId, oppDocId, oppUid) {
    const roomRef = doc(collection(db, "rooms"));
    await setDoc(roomRef, {
        members: Array.from(new Set([my.uid, oppUid])).filter(Boolean),
        createdAt: serverTimestamp(),
        phase: "pendingAccept",
        acceptVoted: [],
        acceptYes: [],
        declinedBy: null,
        invites: {
            to: oppDocId,
            at: serverTimestamp(),
            accepted: null,
        },
    });

    await updateDoc(doc(db, "matchQueue", myDocId), {
        status: "matched",
        roomId: roomRef.id,
        lastActive: serverTimestamp()
    });
    await updateDoc(doc(db, "matchQueue", oppDocId), {
        status: "matched",
        roomId: roomRef.id,
        lastActive: serverTimestamp()
    });

    return roomRef;
}

// ────────────────────── 수락 단계 ──────────────────────
async function myAcceptOrDecline(roomId, accept) {
    await my.requireAuth();
    const ref = doc(db, "rooms", roomId);

    await runTransaction(db, async tx => {
        const s = await tx.get(ref);
        if (!s.exists()) throw new Error("room not found");
        const r = s.data();

        if (r.phase !== "pendingAccept") return;

        const voted = new Set(r.acceptVoted || []);
        const yesSet = new Set(r.acceptYes || []);
        const me = my.uid;

        voted.add(me);
        if (accept) {
            yesSet.add(me);
        } else {
            tx.update(ref, {
                phase: "declined",
                declinedBy: me,
                acceptVoted: Array.from(voted),
                acceptYes: Array.from(yesSet),
                updatedAt: serverTimestamp(),
            });
            return;
        }

        const members = new Set(r.members || []);
        const everyoneVoted = Array.from(members).every(u => voted.has(u));
        const everyoneYes = everyoneVoted && Array.from(members).every(u => yesSet.has(u));

        const patch = {
            acceptVoted: Array.from(voted),
            acceptYes: Array.from(yesSet),
            updatedAt: serverTimestamp(),
        };

        if (everyoneVoted) {
            if (everyoneYes) {
                patch.phase = "accepted";
            } else {
                patch.phase = "declined";
                if (!r.declinedBy) patch.declinedBy = me;
            }
        }

        tx.update(ref, patch);
    });
}

async function waitInviteDecision(roomId, timeoutSec = 30) {
    const ref = doc(db, "rooms", roomId);

    return new Promise(resolve => {
        const t = setTimeout(() => {
            un();
            resolve({ accepted: false, declinedBy: null });
        }, timeoutSec * 1000);

        const un = onSnapshot(ref, snap => {
            if (!snap.exists()) return;
            const r = snap.data();

            if (r.phase === "accepted") {
                clearTimeout(t);
                un();
                resolve({ accepted: true, declinedBy: null });
            }
            if (r.phase === "declined") {
                clearTimeout(t);
                un();
                resolve({ accepted: false, declinedBy: r.declinedBy || null });
            }
        });
    });
}

// ────────────────────── 채팅 시작 Y/n 단계 ──────────────────────
async function myStartYesOrNo(roomId, yes) {
    await my.requireAuth();
    const ref = doc(db, "rooms", roomId);

    await runTransaction(db, async tx => {
        const s = await tx.get(ref);
        if (!s.exists()) throw new Error("room not found");
        const r = s.data();
        if (r.phase !== "startCheck") return;

        if (!yes) {
            tx.update(ref, {
                startVoted: Array.from(new Set([...(r.startVoted || []), my.uid])),
                startYes: Array.from(new Set([...(r.startYes || [])])),
                startDeclinedBy: my.uid,
                phase: "startDeclined",
                updatedAt: serverTimestamp(),
            });
            return;
        }

        const voted = new Set(r.startVoted || []);
        const yesSet = new Set(r.startYes || []);
        voted.add(my.uid);
        yesSet.add(my.uid);

        const all = new Set(r.members || []);
        const everyoneVoted = Array.from(all).every(u => voted.has(u));
        const everyoneYes = everyoneVoted && Array.from(all).every(u => yesSet.has(u));

        const patch = {
            startVoted: Array.from(voted),
            startYes: Array.from(yesSet),
            updatedAt: serverTimestamp(),
        };

        if (everyoneVoted) {
            patch.phase = everyoneYes ? "chatting" : "startDeclined";
            if (!everyoneYes && !r.startDeclinedBy) {
                patch.startDeclinedBy = my.uid;
            }
        }

        tx.update(ref, patch);
    });
}

async function waitStartDecision(roomId, timeoutSec = 30) {
    const ref = doc(db, "rooms", roomId);

    return new Promise(resolve => {
        const t = setTimeout(() => {
            un();
            resolve({ go: false, declinedBy: null });
        }, timeoutSec * 1000);

        const un = onSnapshot(ref, snap => {
            if (!snap.exists()) return;
            const r = snap.data();

            if (r.phase === "chatting") {
                clearTimeout(t);
                un();
                resolve({ go: true, declinedBy: null });
            }
            if (r.phase === "startDeclined") {
                clearTimeout(t);
                un();
                resolve({ go: false, declinedBy: r.startDeclinedBy || null });
            }
        });
    });
}

function gotoRoom(roomId) {
    location.href = `chat.html?room=${encodeURIComponent(roomId)}`;
}

// ────────────────────── 프레즌스 / 채팅 메시지 ──────────────────────
async function cancelMatching() {
    if (!auth.currentUser) return;
    await leaveQueueByUid(my.uid);
}

async function markLeaving() {
    if (!auth.currentUser) return;
    const qy = query(collection(db, "matchQueue"), where("uid", "==", my.uid), limit(1));
    const ss = await getDocs(qy);
    if (ss.empty) return;
    await updateDoc(ss.docs[0].ref, {
        status: "leaving",
        lastActive: serverTimestamp()
    });
}

async function assertRoomMember(roomId) {
    await my.requireAuth();
    const s = await getDoc(doc(db, "rooms", roomId));
    if (!s.exists()) throw new Error("room not found");
    const r = s.data();
    if (!Array.isArray(r.members) || !r.members.includes(my.uid)) {
        throw new Error("you are not a member of this room");
    }
    return true;
}

function onMessages(roomId, cb) {
    const qy = query(
        collection(db, "rooms", roomId, "messages"),
        orderBy("createdAt", "asc"),
        limit(200)
    );
    return onSnapshot(qy, ss =>
        cb(ss.docs.map(d => ({ id: d.id, ...d.data() })))
    );
}

async function sendMessage(roomId, text) {
    await my.requireAuth();
    const t = (text || "").trim();
    if (!t) return;

    let display = "익명";
    try {
        const prof = await my.nowProfile().catch(() => null);
        const nick = (prof?.nickname || "").trim();
        if (nick) display = nick;
        else if (auth.currentUser?.email) {
            display = (auth.currentUser.email.split("@")[0] || "익명");
        }
    } catch { }

    await addDoc(collection(db, "rooms", roomId, "messages"), {
        text: t,
        uid: my.uid,
        email: auth.currentUser?.email ?? null,
        display,
        createdAt: serverTimestamp()
    });
}

async function leaveRoom(roomId) {
    await my.requireAuth();
    const ref = doc(db, "rooms", roomId);
    let leftTo = 0;

    await runTransaction(db, async tx => {
        const s = await tx.get(ref);
        if (!s.exists()) return;
        const r = s.data();
        const members = (r.members || []).filter(u => u !== my.uid);
        leftTo = members.length;

        const patch = { members, updatedAt: serverTimestamp() };
        if (members.length === 0) patch.phase = "ended";
        tx.update(ref, patch);
    });

    await leaveQueueByUid(my.uid);

    if (leftTo > 0) {
        await addDoc(collection(db, "rooms", roomId, "messages"), {
            text: "상대방이 채팅방을 나갔습니다.",
            system: true,
            createdAt: serverTimestamp()
        });
    }
}

// ────────────────────── 매칭 시작 엔트리 ──────────────────────
const api = {
    auth,
    db,

    // 로그인/프로필
    requireAuth: my.requireAuth,
    logout: my.logout,
    loginWithEmailPassword,
    signUpWithEmailPassword,
    sendEmailLink,
    handleEmailLinkIfPresent,
    setPasswordForCurrentUser,
    loadProfile: my.nowProfile,
    saveProfile: my.saveProfile,
    checkNicknameAvailable,

    // 커뮤니티
    createPost,
    listPosts,
    updatePost,
    deletePost,
    onLikeCount,
    togglePostLike,
    listComments,
    addComment,
    deleteComment,
    onCommentLikeCount,
    toggleCommentLike,

    // 신고
    reportUser,

    // 매칭 시작
    startMatching: async (options) => {
        await my.requireAuth();
        await _checkBanOrThrow();

        await leaveQueueByUid(my.uid);
        const myDocId = await enterQueue(options);

        const found = await findOpponent(myDocId);
        if (!found) {
            const myRef = doc(db, "matchQueue", myDocId);
            const room = await new Promise((resolve, reject) => {
                const t = setTimeout(() => {
                    un();
                    reject(new Error("제한 시간 내에 상대를 못 찾았어요."));
                }, MATCH_TIMEOUT_MS);

                const un = onSnapshot(myRef, snap => {
                    if (!snap.exists()) return;
                    const d = snap.data();
                    if (d.status === "matched" && d.roomId) {
                        clearTimeout(t);
                        un();
                        resolve({ id: d.roomId });
                    } else {
                        updateDoc(myRef, { lastActive: serverTimestamp() }).catch(() => { });
                    }
                });
            });
            return room;
        }

        const roomRef = await createRoomAndInvite(myDocId, found.id, found.you.uid);
        return { id: roomRef.id };
    },

    // 수락/거절
    readyToAccept: waitInviteDecision,
    acceptMatch: (roomId) => myAcceptOrDecline(roomId, true),
    declineMatch: (roomId) => myAcceptOrDecline(roomId, false),

    // 2단계용
    readyToChat: waitStartDecision,
    startYes: (roomId) => myStartYesOrNo(roomId, true),
    startNo: (roomId) => myStartYesOrNo(roomId, false),

    gotoRoom,

    // 패널티/프레즌스/채팅
    applyPenalty,
    cancelMatching,
    markLeaving,
    onMessages,
    sendMessage,
    assertRoomMember,
    leaveRoom,

    // 테스트봇
    startWithTestBot: async () => {
        await my.requireAuth();
        await leaveQueueByUid(my.uid);
        const roomRef = doc(collection(db, "rooms"));
        await setDoc(roomRef, {
            members: [my.uid, "__testbot__"],
            createdAt: serverTimestamp(),
            phase: "chatting"
        });
        await addDoc(collection(db, "rooms", roomRef.id, "messages"), {
            text: "테스트봇 연결 완료 ✅ 채팅 입력 테스트 해보세요.",
            uid: "__testbot__",
            email: "bot",
            display: "테스트봇",
            createdAt: serverTimestamp()
        });
        return { id: roomRef.id };
    },

    isAdminEmail,
    addMatchSuccess,
    resetMatchScore,
};

window.fb = api;
window.fbReady = Promise.resolve(api);
window.getFb = async () => window.fbReady;
