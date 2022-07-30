const { getInput, info, getBooleanInput, error } = require('@actions/core');
const { context } = require('@actions/github');
const { execSync } = require('child_process');
const { get } = require('https');
const { resolve } = require('path');

// get the inputs from the action
const pkgid = getInput('identifier');
const verRegex = getInput('version-regex');
const instRegex = getInput('installers-regex');
const delPrevVersion = getBooleanInput('delete-previous-version');
const releaseTag = getInput('release-tag');
const token = getInput('token');
const forkUser = getInput('fork-user');

// check if the runner operating system is windows
if (process.platform != 'win32') {
  error('This action only works on Windows.');
}

// if the workflow was triggered on release event with released/prerelease event type,
// then get release info from the context, else get the release info by tag name
if (
  context.eventName == 'release' &&
  /(pre)?released/g.test(context.payload.action)
) {
  releaseInfo = context.payload.release;
} else if (releaseTag != null) {
  get(
    {
      host: 'api.github.com',
      path: `/repos/${context.repo.owner}/${context.repo.repo}/releases/tags/${releaseTag}`,
      method: 'GET',
      headers: {
        'User-Agent': 'GitHub',
      },
    },
    (res) => {
      let fullResponse = '';
      res
        .on('data', (chunk) => {
          fullResponse += chunk.toString('utf8');
        })
        .on('end', () => {
          releaseInfo = JSON.parse(fullResponse);
        });
    }
  );
} else {
  error('Unable to get release information.');
}

// install powershell-yaml, clone winget-pkgs repo and configure remotes, update yamlcreate, and
// download wingetdev from vedantmgoyal2009/vedantmgoyal2009 (winget-pkgs-automation)
info(
  `::group::Install powershell-yaml, clone winget-pkgs and configure remotes, update YamlCreate, download wingetdev...`
);
execSync(
  `pwsh -Command Install-Module -Name powershell-yaml -Repository PSGallery -Scope CurrentUser -Force`
);
execSync(`git clone https://${token}@github.com/microsoft/winget-pkgs.git`);
execSync(
  `git -C winget-pkgs config --local user.name ${context.payload.sender.login}`
);
execSync(
  `git -C winget-pkgs config --local user.email ${context.payload.sender.id}+${context.payload.sender.login}@users.noreply.github.com`
);
execSync(`git -C winget-pkgs remote rename origin upstream`);
execSync(
  `git -C winget-pkgs remote add origin https://github.com/${forkUser}/winget-pkgs.git`
);
execSync(
  `pwsh -Command Invoke-WebRequest -Uri https://github.com/vedantmgoyal2009/winget-releaser/raw/main/YamlCreate.ps1 -OutFile .\\winget-pkgs\\Tools\\YamlCreate.ps1`
);
execSync(`git -C winget-pkgs commit --all -m \"Update YamlCreate.ps1\"`);
execSync(
  `svn checkout https://github.com/vedantmgoyal2009/vedantmgoyal2009/trunk/tools/wingetdev`
);
info(`::endgroup::`);

// resolve wingetdev path
process.env.WINGETDEV = resolve('wingetdev', 'wingetdev.exe');

info(`::group::Update manifests and create pull request`);
let noOfTimes = 0;
while (noOfTimes <= 6) {
  try {
    execSync(
      `pwsh -Command .\\winget-pkgs\\Tools\\YamlCreate.ps1 \'${JSON.stringify({
        PackageIdentifier: pkgid,
        PackageVersion: new RegExp(verRegex, 'g').exec(releaseInfo.tag_name)[0],
        InstallerUrls: releaseInfo.assets
          .filter((asset) => {
            return new RegExp(instRegex, 'g').test(asset.name);
          })
          .map((asset) => {
            return asset.browser_download_url;
          }),
        ReleaseNotesUrl: releaseInfo.html_url,
        ReleaseDate: new Date(releaseInfo.published_at)
          .toISOString()
          .slice(0, 10),
        DeletePreviousVersion: delPrevVersion,
      }).toString()}\'`
    );
    break;
  } catch (err) {
    if (err.message.includes('InstallerUrls')) {
      if (noOfTimes < 6) {
        noOfTimes++;
        info(
          `Retrying to get installer urls... [${noOfTimes}/5] (after 10 minutes)`
        );
        setTimeout(() => {
          info(
            `10 minutes passed, retrying to get installer urls... [${noOfTimes}/5]`
          );
        }, 600000); // 10 minutes
        get(
          {
            host: 'api.github.com',
            path: `/repos/${context.repo.owner}/${context.repo.repo}/releases/tags/${releaseTag}`,
            method: 'GET',
            headers: {
              'User-Agent': 'GitHub',
            },
          },
          (res) => {
            let fullResponse = '';
            res
              .on('data', (chunk) => {
                fullResponse += chunk.toString('utf8');
              })
              .on('end', () => {
                releaseInfo = JSON.parse(fullResponse);
              });
          }
        );
      } else {
        error(
          `Unable to get installer urls. Please check if all the release assets are uploaded to GitHub.`
        );
      }
    } else {
      error(err);
    }
  }
}
info(`::endgroup::`);
