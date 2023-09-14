import {
  endGroup,
  error,
  getInput,
  startGroup,
  info,
  warning,
  toPlatformPath,
} from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { execSync } from 'node:child_process';

(async () => {
  // get the inputs from the action
  const pkgid = getInput('identifier');
  const version = getInput('version');
  const instRegex = getInput('installers-regex');
  const releaseRepository = getInput('release-repository');
  const releaseTag = getInput('release-tag');
  const maxVersionsToKeep = Number(getInput('max-versions-to-keep'));
  process.env.GITHUB_TOKEN = getInput('token');
  process.env.KMC_FRK_OWNER = getInput('fork-user');

  const github = getOctokit(process.env.GITHUB_TOKEN);

  // install dependencies for running komac
  if (process.platform !== 'win32') {
    startGroup('Installing dependencies for running komac...');
    execSync(
      `${
        process.platform === 'linux' ? 'sudo apt-get -y' : 'brew'
      } install msitools`,
      {
        shell: 'pwsh',
        stdio: 'inherit',
      },
    );
    endGroup();
  }

  // check if at least one version of the package is already present in winget-pkgs repository
  fetch(
    `https://github.com/microsoft/winget-pkgs/tree/master/manifests/${pkgid
      .charAt(0)
      .toLowerCase()}/${pkgid.replaceAll('.', '/')}`,
    { method: 'HEAD' },
  ).then((res) => {
    if (!res.ok) {
      error(
        `Package ${pkgid} does not exist in the winget-pkgs repository. Please add atleast one version of the package before using this action.`,
      );
      process.exit(1);
    }
  });

  // check if max-versions-to-keep is a valid number and is 0 (keep all versions) or greater than 0
  if (!Number.isInteger(maxVersionsToKeep) || maxVersionsToKeep < 0) {
    error(
      'Invalid input supplied: max-versions-to-keep should be 0 (zero - keep all versions) or a positive integer.',
    );
    process.exit(1);
  }

  // fetch komac.jar from the latest release
  execSync(
    `Invoke-WebRequest -Uri https://github.com/russellbanks/Komac/releases/download/v1.11.0/Komac-1.11.0-all.jar -OutFile komac.jar`,
    {
      shell: 'pwsh',
      stdio: 'inherit',
    },
  );

  // get release information using the release tag
  const releaseInfo = {
    ...(
      await github.rest.repos.getReleaseByTag({
        owner: context.repo.owner,
        repo: releaseRepository,
        tag: releaseTag,
      })
    ).data, // get only data, and exclude status, url, and headers
  };

  startGroup('Updating manifests and creating pull request...');
  const pkgVersion =
    version || new RegExp(/(?<=v).*/g).exec(releaseInfo.tag_name)![0];
  const installerUrls = releaseInfo.assets
    .filter((asset) => {
      return new RegExp(instRegex, 'g').test(asset.name);
    })
    .map((asset) => {
      return asset.browser_download_url;
    });

  // execute komac to update the manifest and submit the pull request
  process.env.KMC_CRTD_WITH = `WinGet Releaser ${process.env.GITHUB_ACTION_REF}`;
  process.env.KMC_CRTD_WITH_URL = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_ACTION_REPOSITORY}`;
  const javaPath = toPlatformPath(`${process.env.JAVA_HOME_17_X64}/bin/java`);
  const command = `-jar komac.jar update --id \'${pkgid}\' --version ${pkgVersion} --urls \'${installerUrls.join(
    ',',
  )}\' --submit`;
  info(`Executing command: java ${command}`);
  execSync(`& ${javaPath} ${command}`, {
    shell: 'pwsh',
    stdio: 'inherit',
  });
  endGroup();

  // clean up previous stale branches on the fork, from previous merged pull requests created by this action
  startGroup(
    'Cleaning up previous stale branches of merged pull requests on the fork...',
  );
  const cleanupCmd = `-jar komac.jar branch cleanup --only-merged`;
  info(`Executing command: java ${cleanupCmd}`);
  execSync(`& ${javaPath} ${cleanupCmd}`, {
    shell: 'pwsh',
    stdio: 'inherit',
  });
  endGroup();

  // get the list of existing versions of the package from an api
  let existingVersions: string[] = (
    await (
      await fetch(
        `https://winget.vercel.app/api/winget-pkg-versions?pkgid=${pkgid}`,
      )
    ).json()
  )[pkgid]
    .sort()
    .reverse();

  // if maxVersionsToKeep is not 0, and no. of existing versions is greater than maxVersionsToKeep,
  // delete the older versions (starting from the oldest version)
  startGroup(
    'Checking for deleting old versions with respect to max-versions-to-keep...',
  );

  info(`Number of existing versions: ${existingVersions.length}`);
  info(
    `Number of versions to keep: ${maxVersionsToKeep}${
      maxVersionsToKeep === 0 ? ' (unlimited)' : ''
    }`,
  );

  if (
    maxVersionsToKeep === 0 ||
    existingVersions.length + 1 < maxVersionsToKeep
  ) {
    info('Result: No versions will be deleted.');
    endGroup();
  } else {
    // remove the newer versions from the list of existing versions
    // the left over versions will be deleted
    for (let iterator = 0; iterator < maxVersionsToKeep; iterator++)
      existingVersions.shift();

    info(
      `Result: ${
        existingVersions.length
      } versions will be deleted (${existingVersions.join(', ')}).`,
    );
    endGroup();

    // iterate over the left over versions and delete them
    existingVersions.forEach(async (version) => {
      startGroup(`Deleting version ${version}...`);
      const command = `-jar komac.jar remove --id \'${pkgid}\' --version ${version} --reason \'This version is older than what has been set in \`max-versions-to-keep\` by the publisher.\' --submit`;
      info(`Executing command: java ${command}`);
      execSync(`& ${javaPath} ${command}`, {
        shell: 'pwsh',
        stdio: 'inherit',
      });
      endGroup();
    });
  }

  // check for action updates, and output a warning if there are any
  startGroup('Checking for action updates...');
  const latestVersion = (
    await github.rest.repos.getLatestRelease({
      owner: 'vedantmgoyal2009',
      repo: 'winget-releaser',
    })
  ).data.tag_name;

  info(`Current action version: ${process.env.GITHUB_ACTION_REF}`);
  info(`Latest version found: ${latestVersion}`);

  if (latestVersion > process.env.GITHUB_ACTION_REF!) {
    warning(
      `Please update the action to the latest version (${latestVersion}) by changing the version in the workflow file. You can also use GitHub Dependabot (https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot) to do it automatically in the future.`,
    );
  } else {
    info(`No updates found. Bye bye!`);
  }
  endGroup();
})();
