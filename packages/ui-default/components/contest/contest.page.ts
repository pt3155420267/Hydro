import $ from 'jquery';
import Notification from 'vj/components/notification';
import { AutoloadPage } from 'vj/misc/Page';
import { delay, i18n, request } from 'vj/utils';

const contestPage = new AutoloadPage('contestPage', () => {
  $('[data-contest-code]').on('click', (ev) => {
    ev.preventDefault();
    // eslint-disable-next-line no-alert
    const code = prompt(i18n('请输入比赛的邀请码:'));
    // eslint-disable-next-line no-alert, max-len
    const verfiy = prompt('请认真阅读 PTEZOJ帮助平台(help.ptezoj.com) 中有关于公开比赛《市级公开赛参赛规则》、《市级公开赛违规处罚规则》、《市级公开赛申诉问题公告》的相关内容。\n\n若同意则在下方的对话框中输入:\n我已同意上述条例条款并自愿接受违规处罚');
    request.post('', {
      operation: 'attend',
      code,
      verfiy,
    }).then(() => {
      Notification.success(i18n('邀请码验证通过，报名参加比赛成功'));
      delay(1000).then(() => window.location.reload());
    }).catch((e) => {
      Notification.error('邀请码错误或未同意比赛条例条款' || e);
    });
  });

  $('[data-contest-verfiy]').on('click', (ev) => {
    ev.preventDefault();
    // eslint-disable-next-line no-alert, max-len
    const verfiy = prompt('请认真阅读 PTEZOJ帮助平台(help.ptezoj.com) 中有关于公开比赛《市级公开赛参赛规则》、《市级公开赛违规处罚规则》、《市级公开赛申诉问题公告》的相关内容。\n\n若同意则在下方的对话框中输入:\n我已同意上述条例条款并自愿接受违规处罚');
    request.post('', {
      operation: 'attend',
      verfiy,
    }).then(() => {
      Notification.success(i18n('报名参加比赛成功'));
      delay(1000).then(() => window.location.reload());
    }).catch((e) => {
      Notification.error('未同意比赛条例条款' || e);
    });
  });
});

export default contestPage;
