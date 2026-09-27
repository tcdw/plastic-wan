import { useFrontmatter } from '@rspress/core/runtime';
import {
  EditLink as DefaultEditLink,
  LastUpdated as DefaultLastUpdated,
  Layout as DefaultLayout,
  HomeLayout as DefaultHomeLayout,
} from '@rspress/core/theme-original';
import type { ComponentProps } from 'react';
import { HomeIntro } from './HomeIntro';
import { pageLink } from './links';
import { VersionNotice } from './VersionNotice';
import './styles.css';

function HomeLayout() {
  const { frontmatter } = useFrontmatter();
  if (import.meta.env.SSG_MD) {
    const hero = frontmatter.hero;
    return (
      <>
        <h1>{hero?.name}</h1>
        <p>{hero?.text}</p>
        <p>{hero?.tagline}</p>
        <p>
          {hero?.actions?.map((action) => (
            <a key={action.link} href={action.link.startsWith('/') ? pageLink(action.link) : action.link}>
              {action.text}{' '}
            </a>
          ))}
        </p>
        <HomeIntro />
      </>
    );
  }
  return <DefaultHomeLayout beforeHero={<h1 className="sr-only">塑料碗</h1>} afterHero={<HomeIntro />} />;
}

export function Layout() {
  const { frontmatter } = useFrontmatter();
  if (import.meta.env.SSG_MD) {
    return (
      <>
        {frontmatter.pageType !== 'home' && <VersionNotice />}
        <DefaultLayout HomeLayout={HomeLayout} />
      </>
    );
  }
  return <DefaultLayout HomeLayout={HomeLayout} beforeDocContent={<VersionNotice />} />;
}

// Rspress 2.0.22 does not apply these frontmatter switches to its source controls.
// Generated references have neither an editable Markdown source nor a Git timestamp.
export function EditLink(props: ComponentProps<typeof DefaultEditLink>) {
  const { frontmatter } = useFrontmatter();
  return frontmatter.editLink === false ? null : <DefaultEditLink {...props} />;
}

export function LastUpdated() {
  const { frontmatter } = useFrontmatter();
  return frontmatter.lastUpdated === false ? null : <DefaultLastUpdated />;
}

export * from '@rspress/core/theme-original';
