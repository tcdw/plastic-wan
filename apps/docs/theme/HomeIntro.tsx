import { withBase } from '@rspress/core/runtime';
import { pageLink } from './links';
import { VersionNotice } from './VersionNotice';

export function HomeIntro() {
  return (
    <main className="home-intro">
      <div className="home-intro__columns">
        <section aria-labelledby="own-bowl">
          <h2 id="own-bowl">一只碗，各有各的性格</h2>
          <p>在私聊、群组和 Topic 里，用你选择的模型、人格和参与方式，让对话自然发生。</p>
          <p>它可以看图、使用贴纸、按会话记住一些事；是否开口由模型决定，不是每条消息必回。</p>
          <a href={pageLink('/docs/guides/personality.html')}>从写一份人格开始 →</a>
        </section>
        <section className="home-intro__example" aria-labelledby="example-title">
          <h2 id="example-title">对话可以这样开始</h2>
          <p className="home-intro__caption">虚构示意，不代表实际回复或已保存的记忆</p>
          <p>
            <strong>你</strong>
            <br />
            碗，以后在这个群里话少一点，遇到技术问题再搭把手。
          </p>
          <p>
            <strong>塑料碗</strong>
            <br />
            好，我先在旁边待着。需要时叫我。
          </p>
          <p className="home-intro__caption">想长期保持？将规则写进该群的附加指令，而不只依赖一次聊天。</p>
        </section>
      </div>
      <section className="home-intro__tasks" aria-labelledby="next-task">
        <h2 id="next-task">已经跑起来了？</h2>
        <ul>
          <li>
            <a href={pageLink('/docs/guides/per-chat.html')}>给不同群配置不同的碗</a> <span>模型、指令与参与时段</span>
          </li>
          <li>
            <a href={pageLink('/docs/guides/memory.html')}>管理记忆与遗忘</a> <span>短期记忆、TTL 与人工整理</span>
          </li>
          <li>
            <a href={pageLink('/docs/guides/budgets.html')}>控制用量</a> <span>全局预算与运行限制</span>
          </li>
          <li>
            <a href={pageLink('/docs/guides/images.html')}>让碗画图</a> <span>启用生图、聊天改图与图片管理</span>
          </li>
          <li>
            <a href={pageLink('/docs/operations/troubleshooting.html')}>排查为什么不回复</a>{' '}
            <span>从消息可见性到模型调用</span>
          </li>
        </ul>
      </section>
      <footer className="home-intro__footer">
        <VersionNotice />
        <p>
          <a href={withBase('/llms.txt')}>Agent 文档索引</a> · <a href={withBase('/llms-full.txt')}>完整 Markdown</a>
        </p>
      </footer>
    </main>
  );
}
