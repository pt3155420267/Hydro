import AdmZip from 'adm-zip';
import { statSync } from 'fs-extra';
import { pick } from 'lodash';
import moment from 'moment-timezone';
import { ObjectId } from 'mongodb';
import {
    Counter, sortFiles, streamToBuffer, Time,
} from '@hydrooj/utils/lib/utils';
import {
    BadRequestError, ContestNotAttendedError, ContestNotEndedError, ContestNotFoundError, ContestNotLiveError,
    ContestScoreboardHiddenError, FileLimitExceededError, FileUploadError,
    InvalidTokenError, NotAssignedError, PermissionError, ValidationError,
} from '../error';
import { ScoreboardConfig, Tdoc } from '../interface';
import paginate from '../lib/paginate';
import { PERM, PRIV, STATUS } from '../model/builtin';
import * as contest from '../model/contest';
import * as discussion from '../model/discussion';
import * as document from '../model/document';
import message from '../model/message';
import * as oplog from '../model/oplog';
import problem from '../model/problem';
import record from '../model/record';
import ScheduleModel from '../model/schedule';
import storage from '../model/storage';
import * as system from '../model/system';
import user from '../model/user';
import {
    Handler, param, post, Types,
} from '../service/server';
import { registerResolver, registerValue } from './api';

registerValue('Contest', [
    ['_id', 'ObjectID!'],
    ['domainId', 'String!'],
    ['docId', 'ObjectID!'],
    ['owner', 'Int!'],
    ['beginAt', 'Date!'],
    ['title', 'String!'],
    ['content', 'String!'],
    ['beginAt', 'Date!'],
    ['endAt', 'Date!'],
    ['attend', 'Int!'],
    ['pids', '[Int]!'],
    ['rated', 'Boolean!'],
]);

registerResolver(
    'Query', 'contest(id: ObjectID!)', 'Contest',
    async (arg, ctx) => {
        ctx.checkPerm(PERM.PERM_VIEW);
        arg.id = new ObjectId(arg.id);
        ctx.tdoc = await contest.get(ctx.args.domainId, new ObjectId(arg.id));
        if (!ctx.tdoc) throw new ContestNotFoundError(ctx.args.domainId, arg.id);
        return ctx.tdoc;
    },
    'Get a contest by ID',
);

ScheduleModel.Worker.addHandler('contest', async (doc) => {
    const tdoc = await contest.get(doc.domainId, doc.tid);
    if (!tdoc) return;
    const tasks = [];
    for (const op of doc.operation) {
        if (op === 'unhide') {
            for (const pid of tdoc.pids) {
                tasks.push(problem.edit(doc.domainId, pid, { hidden: false }));
            }
        }
    }
    await Promise.all(tasks);
});

export class ContestListHandler extends Handler {
    @param('rule', Types.Range(contest.RULES), true)
    @param('group', Types.Name, true)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, rule = '', group = '', page = 1) {
        if (rule && contest.RULES[rule].hidden) throw new BadRequestError();
        const groups = (await user.listGroup(domainId, this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST) ? undefined : this.user._id))
            .map((i) => i.name);
        if (group && !groups.includes(group)) throw new NotAssignedError(group);
        const rules = Object.keys(contest.RULES).filter((i) => !contest.RULES[i].hidden);
        const q = {
            ...this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST) && !group
                ? {}
                : {
                    $or: [
                        { maintainer: this.user._id },
                        { owner: this.user._id },
                        { assign: { $in: groups } },
                        { assign: { $size: 0 } },
                    ],
                },
            ...rule ? { rule } : { rule: { $in: rules } },
            ...group ? { assign: { $in: [group] } } : {},
        };
        const cursor = contest.getMulti(domainId, q).sort({ endAt: -1, beginAt: -1, _id: -1 });
        let qs = rule ? `rule=${rule}` : '';
        if (group) qs += qs ? `&group=${group}` : `group=${group}`;
        const [tdocs, tpcount] = await paginate<Tdoc>(cursor, page, system.get('pagination.contest'));
        const tids = [];
        for (const tdoc of tdocs) tids.push(tdoc.docId);
        const tsdict = await contest.getListStatus(domainId, this.user._id, tids);
        const groupsFilter = groups.filter((i) => !Number.isSafeInteger(+i));
        this.response.template = 'contest_main.html';
        this.response.body = {
            page, tpcount, qs, rule, tdocs, tsdict, groups: groupsFilter, group,
        };
    }
}

export class ContestDetailBaseHandler extends Handler {
    tdoc?: Tdoc<30>;
    tsdoc?: any;

    @param('tid', Types.ObjectId, true)
    async __prepare(domainId: string, tid: ObjectId) {
        if (!tid) return; // ProblemDetailHandler also extends from ContestDetailBaseHandler
        [this.tdoc, this.tsdoc] = await Promise.all([
            contest.get(domainId, tid),
            contest.getStatus(domainId, tid, this.user._id),
        ]);
        if (this.tdoc.assign?.length && !this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)) {
            const groups = await user.listGroup(domainId, this.user._id);
            if (!Set.intersection(this.tdoc.assign, groups.map((i) => i.name)).size) {
                throw new NotAssignedError('contest', tid);
            }
        }
        if (this.tdoc.duration && this.tsdoc?.startAt) {
            this.tsdoc.endAt = moment(this.tsdoc.startAt).add(this.tdoc.duration, 'hours').toDate();
        }
    }

    @param('tid', Types.ObjectId, true)
    async after(domainId: string, tid: ObjectId) {
        if (!tid || this.tdoc.rule === 'homework') return;
        if (this.request.json || !this.response.template) return;
        const pdoc = 'pdoc' in this ? (this as any).pdoc : {};
        this.response.body.overrideNav = [
            {
                name: 'contest_detail',
                displayName: this.tdoc.title,
                args: { tid, prefix: 'contest_detail' },
                checker: () => true,
            },
            {
                name: 'contest_problemlist',
                args: { tid, prefix: 'contest_problemlist' },
                checker: () => true,
            },
            {
                name: 'contest_scoreboard',
                args: { tid, prefix: 'contest_scoreboard' },
                checker: () => contest.canShowScoreboard.call(this, this.tdoc, true),
            },
            {
                displayName: `${String.fromCharCode(65 + this.tdoc.pids.indexOf(pdoc.docId))}. ${pdoc.title}`,
                args: { query: { tid }, pid: pdoc.docId, prefix: 'contest_detail_problem' },
                checker: () => 'pdoc' in this,
            },
        ];
    }
}

export class ContestDetailHandler extends Handler {
    tdoc?: Tdoc<30>;
    tsdoc?: any;

    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        [this.tdoc, this.tsdoc] = await Promise.all([
            contest.get(domainId, tid),
            contest.getStatus(domainId, tid, this.user._id),
        ]);
        if (contest.RULES[this.tdoc.rule].hidden) throw new ContestNotFoundError(domainId, tid);
        if (this.tdoc.assign?.length && !this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)) {
            const groups = await user.listGroup(domainId, this.user._id);
            if (!Set.intersection(this.tdoc.assign, groups.map((i) => i.name)).size) {
                throw new NotAssignedError('contest', tid);
            }
        }
        if (this.tdoc.duration && this.tsdoc?.startAt) {
            this.tsdoc.endAt = moment(this.tsdoc.startAt).add(this.tdoc.duration, 'hours').toDate();
        }
    }

    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        this.response.template = 'contest_detail.html';
        const udict = await user.getList(domainId, [this.tdoc.owner]);
        const fields = ['attend', 'startAt'];
        if (this.tdoc.duration) fields.push('endAt');
        this.response.body = {
            tdoc: this.tdoc,
            tsdoc: pick(this.tsdoc, fields),
            udict,
            files: sortFiles(this.tdoc.files || []),
            urlForFile: (filename: string) => this.url('contest_file_download', { tid, filename }),
        };
        if (this.request.json) return;
        this.response.body.tdoc.content = this.response.body.tdoc.content
            .replace(/\(file:\/\//g, `(./${this.tdoc.docId}/file/`)
            .replace(/="file:\/\//g, `="./${this.tdoc.docId}/file/`);
        const pdoc = 'pdoc' in this ? (this as any).pdoc : {};
        this.response.body.overrideNav = [
            {
                name: 'contest_detail',
                displayName: this.tdoc.title,
                args: { tid, prefix: 'contest_detail' },
                checker: () => true,
            },
            {
                name: 'contest_problemlist',
                args: { tid },
                checker: () => true,
            },
            {
                name: 'contest_scoreboard',
                args: { tid, prefix: 'contest_scoreboard' },
                checker: () => contest.canShowScoreboard.call(this, this.tdoc, true),
            },
            {
                displayName: `${String.fromCharCode(65 + this.tdoc.pids.indexOf(pdoc.docId))}. ${pdoc.title}`,
                args: { query: { tid }, pid: pdoc.docId, prefix: 'contest_detail_problem' },
                checker: () => 'pdoc' in this,
            },
        ];
    }

    @param('tid', Types.ObjectId)
    @param('code', Types.String, true)
    @param('verfiy', Types.String, true)
    async postAttend(domainId: string, tid: ObjectId, code = '', verfiy = '') {
        if (contest.isDone(this.tdoc)) throw new ContestNotLiveError(tid);
        if (this.tdoc._code && code !== this.tdoc._code) throw new InvalidTokenError('Contest Invitation', code);
        if (verfiy !== '我已同意上述条例条款并自愿接受违规处罚') throw new InvalidTokenError('Contest User Verfiy', verfiy);
        await contest.attend(domainId, tid, this.user._id);
        this.back();
    }
}

export class ContestProblemListHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        if (contest.isNotStarted(this.tdoc)) throw new ContestNotLiveError(domainId, tid);
        if (!this.tsdoc?.attend && !contest.isDone(this.tdoc)) throw new ContestNotAttendedError(domainId, tid);
        const [pdict, udict] = await Promise.all([
            problem.getList(domainId, this.tdoc.pids, true, true, problem.PROJECTION_CONTEST_LIST),
            user.getList(domainId, [this.tdoc.owner, this.user._id]),
        ]);
        this.response.body = {
            pdict, psdict: {}, udict, rdict: {}, tdoc: this.tdoc, tsdoc: this.tsdoc,
        };
        this.response.template = 'contest_problemlist.html';
        if (!this.tsdoc) return;
        if (this.tsdoc.attend && !this.tsdoc.startAt && contest.isOngoing(this.tdoc)) {
            await contest.setStatus(domainId, tid, this.user._id, { startAt: new Date() });
            this.tsdoc.startAt = new Date();
        }
        this.response.body.psdict = this.tsdoc.detail || {};
        const psdocs: any[] = Object.values(this.response.body.psdict);
        if (contest.canShowSelfRecord.call(this, this.tdoc)) {
            [this.response.body.rdict, this.response.body.rdocs] = await Promise.all([
                record.getList(domainId, psdocs.map((i: any) => i.rid)),
                await record.getMulti(domainId, { contest: tid, uid: this.user._id })
                    .sort({ _id: -1 }).toArray(),
            ]);
            this.response.body.canViewRecord = true;
        } else {
            for (const i of psdocs) this.response.body.rdict[i.rid] = { _id: i.rid };
        }
    }
}

export class ContestScoreboardHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    @param('ext', Types.Range(['csv', 'html', 'ghost']), true)
    @param('realtime', Types.Boolean)
    async get(domainId: string, tid: ObjectId, ext = '', realtime) {
        if (!contest.canShowScoreboard.call(this, this.tdoc, true)) throw new ContestScoreboardHiddenError(tid);
        if (contest.isNotStarted(this.tdoc)) throw new ContestNotLiveError(domainId, tid);
        if (realtime && !this.user.own(this.tdoc)) {
            this.checkPerm(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
        }
        if (ext) {
            await this.exportScoreboard(domainId, tid, ext);
            return;
        }
        const config: ScoreboardConfig = { isExport: false };
        if (!realtime && this.tdoc.lockAt && !this.tdoc.unlocked) {
            config.lockAt = this.tdoc.lockAt;
        }
        const [, rows, udict, pdict] = await contest.getScoreboard.call(this, domainId, tid, config);
        const groups = this.user.hasPerm(PERM.PERM_EDIT_DOMAIN)
            ? await user.listGroup(domainId) : [];
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const page_name = this.tdoc.rule === 'homework'
            ? 'homework_scoreboard'
            : 'contest_scoreboard';
        const tsdoc = pick(this.tsdoc, ['attend', 'startAt', ...(this.tdoc.duration ? ['endAt'] : [])]);
        this.response.body = {
            tdoc: this.tdoc, tsdoc, rows, udict, pdict, page_name, groups,
        };
        this.response.pjax = 'partials/scoreboard.html';
        this.response.template = 'contest_scoreboard.html';
    }

    async exportGhost(domainId: string, tid: ObjectId) {
        const tdoc = this.tdoc;
        const [pdict, teams] = await Promise.all([
            problem.getList(domainId, tdoc.pids, true, false, problem.PROJECTION_LIST, true),
            contest.getMultiStatus(domainId, { docId: tid }).toArray(),
        ]);
        const udict = await user.getList(domainId, teams.map((i) => i.uid));
        const teamIds: Record<number, number> = {};
        for (let i = 1; i <= teams.length; i++) teamIds[teams[i - 1].uid] = i;
        const time = (t: ObjectId) => Math.floor((t.getTimestamp().getTime() - tdoc.beginAt.getTime()) / Time.second);
        const pid = (i: number) => String.fromCharCode(65 + i);
        const escape = (i: string) => i.replace(/[",]/g, '');
        const unknownSchool = this.translate('Unknown School');
        const submissions = teams.flatMap((i, idx) => {
            if (!i.journal) return [];
            const journal = i.journal.filter((s) => tdoc.pids.includes(s.pid));
            const c = Counter();
            return journal.map((s) => {
                const id = pid(tdoc.pids.indexOf(s.pid));
                c[id]++;
                return `@s ${idx + 1},${id},${c[id]},${time(s.rid)},${s.status === STATUS.STATUS_ACCEPTED ? 'AC' : 'RJ'}`;
            });
        });
        const res = [
            `@contest "${escape(tdoc.title)}"`,
            `@contlen ${Math.floor((tdoc.endAt.getTime() - tdoc.beginAt.getTime()) / Time.minute)}`,
            `@problems ${tdoc.pids.length}`,
            `@teams ${tdoc.attend}`,
            `@submissions ${submissions.length}`,
        ].concat(
            tdoc.pids.map((i, idx) => `@p ${pid(idx)},${escape(pdict[i]?.title || 'Unknown Problem')},20,0`),
            teams.map((i, idx) => `@t ${idx + 1},0,1,${escape(udict[i.uid].school || unknownSchool)}-${escape(udict[i.uid].uname)}`),
            submissions,
        );
        this.binary(res.join('\n'), `${this.tdoc.title}.ghost`);
    }

    async exportScoreboard(domainId: string, tid: ObjectId, ext: string) {
        await this.limitRate('scoreboard_download', 60, 3);
        if (ext === 'ghost') {
            if (contest.isLocked(this.tdoc) && !this.user.own(this.tdoc)) {
                this.checkPerm(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
            }
            await this.exportGhost(domainId, tid);
            return;
        }
        const getContent = {
            csv: async (rows) => `\uFEFF${rows.map((c) => (c.map((i) => i.value?.toString().replace(/\n/g, ' ')).join(','))).join('\n')}`,
            html: (rows, tdoc) => this.renderHTML('contest_scoreboard_download_html.html', { rows, tdoc }),
        };
        const [, rows] = await contest.getScoreboard.call(this, domainId, tid, { isExport: true, lockAt: this.tdoc.lockAt });
        this.binary(await getContent[ext](rows, this.tdoc), `${this.tdoc.title}.${ext}`);
    }

    @param('tid', Types.ObjectId)
    async postUnlock(domainId: string, tid: ObjectId) {
        if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
        if (!contest.isDone(this.tdoc)) throw new ContestNotEndedError(domainId, tid);
        await contest.unlockScoreboard(domainId, tid);
        this.back();
    }
}

export class ContestEditHandler extends Handler {
    tdoc: Tdoc;

    @param('tid', Types.ObjectId, true)
    async prepare(domainId: string, tid: ObjectId) {
        if (tid) {
            this.tdoc = await contest.get(domainId, tid);
            if (!this.tdoc) throw new ContestNotFoundError(domainId, tid);
            if (contest.RULES[this.tdoc.rule].hidden) throw new ContestNotFoundError(domainId, tid);
            if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            else this.checkPerm(PERM.PERM_EDIT_CONTEST_SELF);
        } else this.checkPerm(PERM.PERM_CREATE_CONTEST);
    }

    @param('tid', Types.ObjectId, true)
    async get(domainId: string, tid: ObjectId) {
        this.response.template = 'contest_edit.html';
        const rules = {};
        for (const i in contest.RULES) {
            if (!contest.RULES[i].hidden) {
                rules[i] = contest.RULES[i].TEXT;
            }
        }
        let ts = Date.now();
        ts = ts - (ts % (15 * Time.minute)) + 15 * Time.minute;
        const beginAt = moment(this.tdoc?.beginAt || new Date(ts)).tz(this.user.timeZone);
        this.response.body = {
            rules,
            tdoc: this.tdoc,
            duration: tid ? -beginAt.diff(this.tdoc.endAt, 'hour', true) : 2,
            pids: tid ? this.tdoc.pids.join(',') : '',
            beginAt,
            page_name: tid ? 'contest_edit' : 'contest_create',
        };
    }

    @param('tid', Types.ObjectId, true)
    @param('beginAtDate', Types.Date)
    @param('beginAtTime', Types.Time)
    @param('duration', Types.Float)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('rule', Types.Range(Object.keys(contest.RULES).filter((i) => !contest.RULES[i].hidden)))
    @param('pids', Types.Content)
    @param('rated', Types.Boolean)
    @param('code', Types.String, true)
    @param('autoHide', Types.Boolean)
    @param('assign', Types.CommaSeperatedArray, true)
    @param('lock', Types.UnsignedInt, true)
    @param('contestDuration', Types.Float, true)
    @param('maintainer', Types.NumericArray, true)
    @param('allowViewCode', Types.Boolean)
    async postUpdate(
        domainId: string, tid: ObjectId, beginAtDate: string, beginAtTime: string, duration: number,
        title: string, content: string, rule: string, _pids: string, rated = false,
        _code = '', autoHide = false, assign: string[] = [], lock: number = null,
        contestDuration: number = null, maintainer: number[] = [], allowViewCode = false,
    ) {
        if (autoHide) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
        const pids = _pids.replace(/，/g, ',').split(',').map((i) => +i).filter((i) => i);
        const beginAtMoment = moment.tz(`${beginAtDate} ${beginAtTime}`, this.user.timeZone);
        if (!beginAtMoment.isValid()) throw new ValidationError('beginAtDate', 'beginAtTime');
        const endAt = beginAtMoment.clone().add(duration, 'hours').toDate();
        if (beginAtMoment.isSameOrAfter(endAt)) throw new ValidationError('duration');
        const beginAt = beginAtMoment.toDate();
        const lockAt = lock ? moment(endAt).add(-lock, 'minutes').toDate() : null;
        await problem.getList(domainId, pids, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id, true);
        if (tid) {
            await contest.edit(domainId, tid, {
                title, content, rule, beginAt, endAt, pids, rated, duration: contestDuration,
            });
            if (this.tdoc.beginAt !== beginAt || this.tdoc.endAt !== endAt
                || Array.isDiff(this.tdoc.pids, pids) || this.tdoc.rule !== rule
                || lockAt !== this.tdoc.lockAt) {
                await contest.recalcStatus(domainId, this.tdoc.docId);
            }
        } else {
            tid = await contest.add(domainId, title, content, this.user._id, rule, beginAt, endAt, pids, rated, { duration: contestDuration });
        }
        const task = {
            type: 'schedule', subType: 'contest', domainId, tid,
        };
        await ScheduleModel.deleteMany(task);
        const operation = [];
        if (Date.now() <= endAt.getTime() && autoHide) {
            // eslint-disable-next-line no-await-in-loop
            await Promise.all(pids.map((pid) => problem.edit(domainId, pid, { hidden: true })));
            operation.push('unhide');
        }
        if (operation.length) {
            await ScheduleModel.add({
                ...task,
                operation,
                executeAfter: endAt,
            });
        }
        await contest.edit(domainId, tid, {
            assign, _code, autoHide, lockAt, maintainer, allowViewCode,
        });
        this.response.body = { tid };
        this.response.redirect = this.url('contest_detail', { tid });
    }

    @param('tid', Types.ObjectId)
    async postDelete(domainId: string, tid: ObjectId) {
        if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
        const [ddocs] = await Promise.all([
            discussion.getMulti(domainId, { parentType: document.TYPE_CONTEST, parentId: tid }).project({ _id: 1 }).toArray(),
            contest.del(domainId, tid),
        ]);
        const tasks: any[] = ddocs.map((i) => discussion.del(domainId, i._id));
        await Promise.all(tasks.concat([
            record.updateMulti(domainId, { domainId, contest: tid }, undefined, undefined, { contest: '' }),
            ScheduleModel.deleteMany({
                type: 'schedule', subType: 'contest', domainId, tid,
            }),
        ]));
        this.response.redirect = this.url('contest_main');
    }
}

export class ContestManagementBaseHandler extends ContestDetailBaseHandler {
    async prepare() {
        if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
    }
}

export class ContestCodeHandler extends Handler {
    @param('tid', Types.ObjectId)
    @param('all', Types.Boolean)
    async get(domainId: string, tid: ObjectId, all: boolean) {
        await this.limitRate('contest_code', 60, 10);
        const [tdoc, tsdocs] = await contest.getAndListStatus(domainId, tid);
        if (!this.user.own(tdoc) && !this.user.hasPriv(PRIV.PRIV_READ_RECORD_CODE)) {
            this.checkPerm(PERM.PERM_READ_RECORD_CODE);
        }
        if (!contest.canShowRecord.call(this, tdoc as any, true)) {
            throw new PermissionError(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
        }
        const rnames = {};
        for (const tsdoc of tsdocs) {
            if (all) {
                for (const j of tsdoc.journal || []) {
                    let name = `U${tsdoc.uid}_P${j.pid}_R${j.rid}`;
                    if (typeof j.score === 'number') name += `_S${j.status || 0}@${j.score}`;
                    rnames[j.rid] = name;
                }
            } else {
                for (const pid in tsdoc.detail || {}) {
                    let name = `U${tsdoc.uid}_P${pid}_R${tsdoc.detail[pid].rid}`;
                    if (typeof tsdoc.detail[pid].score === 'number') name += `_S${tsdoc.detail[pid].status || 0}@${tsdoc.detail[pid].score}`;
                    rnames[tsdoc.detail[pid].rid] = name;
                }
            }
        }
        const zip = new AdmZip();
        const rdocs = await record.getMulti(domainId, {
            _id: { $in: Array.from(Object.keys(rnames)).map((id) => new ObjectId(id)) },
        }).toArray();
        await Promise.all(rdocs.map(async (rdoc) => {
            if (rdoc.files?.code) {
                const [id, filename] = rdoc.files?.code?.split('#') || [];
                if (!id) return;
                zip.addFile(
                    `${rnames[rdoc._id.toHexString()]}.${filename || 'txt'}`,
                    await streamToBuffer(await storage.get(`submission/${id}`)),
                );
            } else if (rdoc.code) {
                zip.addFile(`${rnames[rdoc._id.toHexString()]}.${rdoc.lang}`, Buffer.from(rdoc.code));
            }
        }));
        this.binary(zip.toBuffer(), `${tdoc.title}.zip`);
    }
}

export class ContestManagementHandler extends ContestManagementBaseHandler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        this.response.body = {
            tdoc: this.tdoc,
            tsdoc: this.tsdoc,
            owner_udoc: await user.getById(domainId, this.tdoc.owner),
            pdict: await problem.getList(domainId, this.tdoc.pids, true, true, problem.PROJECTION_CONTEST_LIST),
            files: sortFiles(this.tdoc.files || []),
            urlForFile: (filename: string) => this.url('contest_file_download', { tid, filename }),
        };
        this.response.pjax = 'partials/files.html';
        this.response.template = 'contest_manage.html';
    }

    @param('tid', Types.ObjectId)
    @param('content', Types.Content)
    async postBroadcast(domainId: string, tid: ObjectId, content: string) {
        const tsdocs = await contest.getMultiStatus(domainId, { docId: tid }).toArray();
        const uids = Array.from<number>(new Set(tsdocs.map((tsdoc) => tsdoc.uid)));
        const flag = contest.isOngoing(this.tdoc) ? message.FLAG_ALERT : message.FLAG_UNREAD;
        await Promise.all(uids.map((uid) => message.send(this.user._id, uid, content, flag)));
        this.back();
    }

    @param('tid', Types.ObjectId)
    @post('filename', Types.Filename, true)
    async postUploadFile(domainId: string, tid: ObjectId, filename: string) {
        if ((this.tdoc.files?.length || 0) >= system.get('limit.contest_files')) {
            throw new FileLimitExceededError('count');
        }
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const f = statSync(file.filepath);
        const size = Math.sum((this.tdoc.files || []).map((i) => i.size)) + f.size;
        if (size >= system.get('limit.contest_files_size')) {
            throw new FileLimitExceededError('size');
        }
        filename ||= file.originalFilename || String.random(16);
        if (filename.includes('/') || filename.includes('..')) throw new ValidationError('filename', null, 'Bad filename');
        await storage.put(`contest/${domainId}/${tid}/${filename}`, file.filepath, this.user._id);
        const meta = await storage.getMeta(`contest/${domainId}/${tid}/${filename}`);
        const payload = { _id: filename, name: filename, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!meta) throw new FileUploadError();
        await contest.edit(domainId, tid, { files: [...(this.tdoc.files || []), payload] });
        this.back();
    }

    @param('tid', Types.ObjectId)
    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, tid: ObjectId, files: string[]) {
        await Promise.all([
            storage.del(files.map((t) => `contest/${domainId}/${tid}/${t}`), this.user._id),
            contest.edit(domainId, tid, { files: this.tdoc.files.filter((i) => !files.includes(i.name)) }),
        ]);
        this.back();
    }
}

export class ContestFileDownloadHandler extends ContestDetailBaseHandler {
    @param('tid', Types.ObjectId)
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean)
    async get(domainId: string, tid: ObjectId, filename: string, noDisposition = false) {
        this.response.addHeader('Cache-Control', 'public');
        const target = `contest/${domainId}/${tid}/${filename}`;
        const file = await storage.getMeta(target);
        await oplog.log(this, 'download.file.contest', {
            target,
            size: file?.size || 0,
        });
        this.response.redirect = await storage.signDownloadLink(
            target, noDisposition ? undefined : filename, false, 'user',
        );
    }
}

export class ContestUserHandler extends ContestManagementBaseHandler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const tsdocs = await contest.getMultiStatus(domainId, { docId: tid }).project({
            uid: 1, attend: 1, startAt: 1, unrank: 1,
        }).toArray();
        tsdocs.forEach((i) => {
            i.endAt = (this.tdoc.duration && i.startAt) ? moment(i.startAt).add(this.tdoc.duration, 'hours').toDate() : null;
        });
        const udict = await user.getListForRender(domainId, [this.tdoc.owner, ...tsdocs.map((i) => i.uid)]);
        this.response.body = { tdoc: this.tdoc, tsdocs, udict };
        this.response.pjax = 'partials/contest_user.html';
        this.response.template = 'contest_user.html';
    }

    @param('tid', Types.ObjectId)
    @param('uids', Types.NumericArray)
    @param('unrank', Types.Boolean)
    async postAddUser(domainId: string, tid: ObjectId, uids: number[], unrank = false) {
        await Promise.all(uids.map((uid) => contest.attend(domainId, tid, uid, { unrank })));
        this.back();
    }

    @param('tid', Types.ObjectId)
    @param('uid', Types.PositiveInt)
    async postRank(domainId: string, tid: ObjectId, uid: number) {
        const tsdoc = await contest.getStatus(domainId, tid, uid);
        if (!tsdoc) throw new ContestNotAttendedError(uid);
        await contest.setStatus(domainId, tid, uid, { unrank: !tsdoc.unrank });
        this.back();
    }
}
export async function apply(ctx) {
    ctx.Route('contest_create', '/contest/create', ContestEditHandler);
    ctx.Route('contest_main', '/contest', ContestListHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_detail', '/contest/:tid', ContestDetailHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_problemlist', '/contest/:tid/problems', ContestProblemListHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_edit', '/contest/:tid/edit', ContestEditHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_scoreboard', '/contest/:tid/scoreboard', ContestScoreboardHandler, PERM.PERM_VIEW_CONTEST_SCOREBOARD);
    ctx.Route('contest_scoreboard_download', '/contest/:tid/export/:ext', ContestScoreboardHandler, PERM.PERM_VIEW_CONTEST_SCOREBOARD);
    ctx.Route('contest_manage', '/contest/:tid/management', ContestManagementHandler);
    ctx.Route('contest_code', '/contest/:tid/code', ContestCodeHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_file_download', '/contest/:tid/file/:filename', ContestFileDownloadHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_user', '/contest/:tid/user', ContestUserHandler, PERM.PERM_VIEW_CONTEST);
}
