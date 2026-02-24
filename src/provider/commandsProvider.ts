import * as vscode from 'vscode';
import { DataFile, DisposeProvider, formatDuration, Interval, timew } from '../dataAccess';
import * as actions from './actions';

interface TagSummary {
  tag: string;
  duration: number;
  estimatedDuration: number;
}

interface MonthSummary {
  title: string;
  dailyDurations: Array<number>;
  totalDuration: number;
  tags: Array<TagSummary>;
  individualTags: Array<TagSummary>;
  hasMultiTagIntervals: boolean;
  showEstimation: boolean;
  estimationLabel: string;
}

export class CommandsProvider extends DisposeProvider {
  #activeDataFile: DataFile | undefined;
  constructor(private readonly dataFileEvent: vscode.Event<Array<DataFile>>) {
    super();

    this.subscriptions = [
      dataFileEvent(dataFiles => {
        this.#activeDataFile = dataFiles.find(obj => obj.isActive);
      }),
      vscode.commands.registerCommand('timewarrior.start', this.start, this),
      vscode.commands.registerCommand('timewarrior.startNoTags', this.startNoTags, this),
      vscode.commands.registerCommand('timewarrior.startPrevTag', this.startPrevTag, this),
      vscode.commands.registerCommand('timewarrior.tag', this.tag, this),
      vscode.commands.registerCommand('timewarrior.stop', this.stop, this),
      vscode.commands.registerCommand('timewarrior.checkIn', this.checkIn, this),
      vscode.commands.registerCommand('timewarrior.edit', this.edit, this),
      vscode.commands.registerCommand('timewarrior.monthSummary', this.monthSummary, this),
    ];
  }

  private async startNoTags(...args: string[]) {
    await timew('start', args);
  }
  private async start() {
    const tags = await actions.getInputArgs(this.#activeDataFile);
    if (tags) {
      await timew('start', tags);
    }
  }
  private async startPrevTag() {
    if (this.#activeDataFile) {
      const intervals = await this.#activeDataFile.getIntervals();
      if (intervals.length > 1) {
        intervals.pop();
        const prevTag = intervals.pop();
        if (prevTag?.tags) {
          await timew('start', prevTag.tags);
        }
      }
    }
  }

  private async tag() {
    const tags = await actions.getInputArgs(this.#activeDataFile);
    if (tags) {
      await timew('tag', tags);
    }
  }

  private async stop() {
    await timew('stop');
  }

  private async checkIn() {
    const actions = await this.getActions();
    const result =
      actions.length > 1
        ? await vscode.window.showQuickPick(actions, {
            placeHolder: 'Please select action',
          })
        : actions.pop();
    if (result) {
      if (result.args && !Array.isArray(result.args)) {
        result.args = await result.args();
      }
      await await timew(result.command, result.args);
    }
  }

  private async getActions() {
    const result: Array<actions.CheckInAction> = [];

    const actionProviders = [
      actions.startCheckInProvider,
      actions.tagsCheckInProvider,
      actions.configTagsCheckInProvider,
      actions.gitCheckInProvider,
      actions.stopCheckInProvider,
    ];
    for (const actionProvider of actionProviders) {
      result.push(...(await actionProvider(this.#activeDataFile)));
    }
    return result.sort((obj1, obj2) => obj1.label.localeCompare(obj2.label));
  }

  private async edit(): Promise<void> {
    if (this.#activeDataFile) {
      const uri = this.#activeDataFile.uri;
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
    }
  }

  private async monthSummary(dataFile?: DataFile): Promise<void> {
    const target = dataFile || this.#activeDataFile;
    if (!target) {
      vscode.window.showInformationMessage('No month selected for summary.');
      return;
    }

    const summary = await this.createMonthSummary(target);
    const panel = vscode.window.createWebviewPanel(
      'timewarrior_month_summary',
      `Timewarrior ${summary.title}`,
      vscode.ViewColumn.Active,
      {
        enableFindWidget: true,
      }
    );
    panel.webview.html = this.getMonthSummaryHtml(summary);
  }

  private async createMonthSummary(dataFile: DataFile): Promise<MonthSummary> {
    const intervals = await dataFile.getIntervals();
    const year = dataFile.date.getFullYear();
    const month = dataFile.date.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 1);

    const dailyDurations = Array.from({ length: daysInMonth }, () => 0);
    const tagDurations: Record<string, number> = {};
    const individualTagDurations: Record<string, number> = {};
    let hasMultiTagIntervals = false;

    for (const interval of intervals) {
      const hasMultipleTags = this.addIntervalToSummary(
        interval,
        monthStart,
        monthEnd,
        dailyDurations,
        tagDurations,
        individualTagDurations
      );
      if (hasMultipleTags) {
        hasMultiTagIntervals = true;
      }
    }

    const now = new Date();
    const monthIndex = year * 12 + month;
    const currentMonthIndex = now.getFullYear() * 12 + now.getMonth();
    const showEstimation = monthIndex >= currentMonthIndex;
    const estimationFactor = monthIndex === currentMonthIndex ? daysInMonth / Math.max(1, now.getDate()) : 1;

    const tags = Object.entries(tagDurations)
      .map(([tag, duration]) => ({
        tag,
        duration,
        estimatedDuration: duration * estimationFactor,
      }))
      .sort((obj1, obj2) => obj2.duration - obj1.duration);

    const individualTags = Object.entries(individualTagDurations)
      .map(([tag, duration]) => ({
        tag,
        duration,
        estimatedDuration: duration * estimationFactor,
      }))
      .sort((obj1, obj2) => obj2.duration - obj1.duration);

    return {
      title: dataFile.date.toLocaleString('default', { month: 'long', year: 'numeric' }),
      dailyDurations,
      totalDuration: dailyDurations.reduce((sum, curr) => sum + curr, 0),
      tags,
      individualTags,
      hasMultiTagIntervals,
      showEstimation,
      estimationLabel: monthIndex === currentMonthIndex ? 'Estimated month end' : 'Estimation',
    };
  }

  private addIntervalToSummary(
    interval: Interval,
    monthStart: Date,
    monthEnd: Date,
    dailyDurations: Array<number>,
    tagDurations: Record<string, number>,
    individualTagDurations: Record<string, number>
  ) {
    const intervalStart = interval.start;
    const intervalEnd = interval.end || new Date();
    const effectiveStart = new Date(Math.max(intervalStart.getTime(), monthStart.getTime()));
    const effectiveEnd = new Date(Math.min(intervalEnd.getTime(), monthEnd.getTime()));

    if (effectiveEnd <= effectiveStart) {
      return false;
    }

    const duration = effectiveEnd.getTime() - effectiveStart.getTime();
    this.addDurationByDay(effectiveStart, effectiveEnd, dailyDurations, monthStart);

    const tagKey = interval.tags.length > 0 ? interval.tags.join(', ') : 'no tag';
    this.addDurationToBucket(tagDurations, tagKey, duration);

    if (interval.tags.length > 0) {
      for (const tag of interval.tags) {
        this.addDurationToBucket(individualTagDurations, tag, duration);
      }
    } else {
      this.addDurationToBucket(individualTagDurations, 'no tag', duration);
    }

    return interval.tags.length > 1;
  }

  private addDurationToBucket(bucket: Record<string, number>, key: string, duration: number) {
    if (!bucket[key]) {
      bucket[key] = 0;
    }
    bucket[key] += duration;
  }

  private addDurationByDay(
    rangeStart: Date,
    rangeEnd: Date,
    dailyDurations: Array<number>,
    monthStart: Date
  ) {
    const year = monthStart.getFullYear();
    const month = monthStart.getMonth();
    let cursor = new Date(rangeStart);
    while (cursor < rangeEnd) {
      const startOfDay = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
      const endOfDay = new Date(startOfDay);
      endOfDay.setDate(endOfDay.getDate() + 1);
      const segmentEnd = new Date(Math.min(endOfDay.getTime(), rangeEnd.getTime()));

      if (cursor.getFullYear() === year && cursor.getMonth() === month) {
        const dayIndex = cursor.getDate() - 1;
        if (dayIndex >= 0 && dayIndex < dailyDurations.length) {
          dailyDurations[dayIndex] += segmentEnd.getTime() - cursor.getTime();
        }
      }

      cursor = segmentEnd;
    }
  }

  private getMonthSummaryHtml(summary: MonthSummary) {
    const pieColors = [
      'var(--vscode-charts-blue)',
      'var(--vscode-charts-green)',
      'var(--vscode-charts-yellow)',
      'var(--vscode-charts-orange)',
      'var(--vscode-charts-purple)',
      'var(--vscode-charts-red)',
      'var(--vscode-charts-foreground)',
    ];
    const totalTagDuration = summary.tags.reduce((sum, curr) => sum + curr.duration, 0);
    let percentageOffset = 0;
    const pieSegments = summary.tags
      .map((tag, index) => {
        const start = percentageOffset;
        const slicePercent = totalTagDuration > 0 ? (tag.duration / totalTagDuration) * 100 : 0;
        percentageOffset += slicePercent;
        return `${pieColors[index % pieColors.length]} ${start}% ${percentageOffset}%`;
      })
      .join(', ');
    const pieBackground =
      totalTagDuration > 0
        ? `conic-gradient(${pieSegments})`
        : 'conic-gradient(var(--vscode-panel-border) 0% 100%)';
    const estimationHeaderCell = summary.showEstimation
      ? `<th class="num">${this.escapeHtml(summary.estimationLabel)}</th>`
      : '';
    const legendItems =
      summary.tags.length > 0
        ? summary.tags
            .map((tag, index) => {
              const ratio = totalTagDuration > 0 ? (tag.duration / totalTagDuration) * 100 : 0;
              const ratioLabel = `${ratio.toFixed(1)}%`;
              return `<div class="legend-row"><span class="legend-swatch" style="background:${pieColors[index % pieColors.length]};"></span><span class="legend-tag">${this.escapeHtml(tag.tag)}</span><span class="legend-value">${this.formatDuration(tag.duration)} · ${ratioLabel}</span></div>`;
            })
            .join('')
        : '<div class="muted">No tracked tags for this month.</div>';

    const emptyEstimationColumn = summary.showEstimation ? '<td class="num">00:00</td>' : '';
    const estimatedTotalDuration = summary.tags.reduce((sum, curr) => sum + curr.estimatedDuration, 0);
    const rows =
      summary.tags.length > 0
        ? summary.tags
            .map(tag => {
              const estimationColumn = summary.showEstimation
                ? `<td class="num">${this.formatDuration(tag.estimatedDuration)}</td>`
                : '';
              return `<tr><td>${this.escapeHtml(tag.tag)}</td><td class="num">${this.formatDuration(tag.duration)}</td>${estimationColumn}</tr>`;
            })
            .join('')
        : `<tr><td>no data</td><td class="num">00:00</td>${emptyEstimationColumn}</tr>`;
    const estimationTotalCell = summary.showEstimation
      ? `<th class="num">${this.formatDuration(estimatedTotalDuration)}</th>`
      : '';
    const totalRow = `<tr><th>Total</th><th class="num">${this.formatDuration(summary.totalDuration)}</th>${estimationTotalCell}</tr>`;

    const individualRows =
      summary.individualTags.length > 0
        ? summary.individualTags
            .map(tag => {
              const estimationColumn = summary.showEstimation
                ? `<td class="num">${this.formatDuration(tag.estimatedDuration)}</td>`
                : '';
              return `<tr><td>${this.escapeHtml(tag.tag)}</td><td class="num">${this.formatDuration(tag.duration)}</td>${estimationColumn}</tr>`;
            })
            .join('')
        : `<tr><td>no data</td><td class="num">00:00</td>${emptyEstimationColumn}</tr>`;
    const individualSummarySection = summary.hasMultiTagIntervals
      ? `<div class="section">
    <h2>Per-tag summary</h2>
    <table>
      <thead>
        <tr>
          <th>Tag</th>
          <th class="num">Tracked</th>
          ${estimationHeaderCell}
        </tr>
      </thead>
      <tbody>${individualRows}</tbody>
    </table>
  </div>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Timewarrior ${this.escapeHtml(summary.title)}</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px; }
    h1, h2 { margin: 0 0 8px 0; font-weight: 600; }
    .muted { color: var(--vscode-descriptionForeground); margin-bottom: 14px; }
    .chart-wrap { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; display: flex; gap: 14px; align-items: center; }
    .pie { width: 180px; height: 180px; border-radius: 50%; border: 1px solid var(--vscode-panel-border); flex: 0 0 auto; }
    .legend { flex: 1 1 auto; min-width: 220px; }
    .legend-row { display: grid; grid-template-columns: 12px minmax(120px, 1fr) auto; align-items: center; gap: 8px; margin-bottom: 6px; }
    .legend-swatch { width: 12px; height: 12px; border-radius: 2px; border: 1px solid var(--vscode-panel-border); }
    .legend-tag { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .legend-value { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; }
    th { font-weight: 600; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .section { margin-top: 18px; }
  </style>
</head>
<body>
  <h1>${this.escapeHtml(summary.title)} summary</h1>
  <div class="muted">Total tracked: ${this.formatDuration(summary.totalDuration)}</div>

  <div class="section">
    <h2>Month graph</h2>
    <div class="chart-wrap">
      <div class="pie" style="background:${pieBackground}"></div>
      <div class="legend">${legendItems}</div>
    </div>
  </div>

  <div class="section">
    <h2>Tag summary</h2>
    <table>
      <thead>
        <tr>
          <th>Tag</th>
          <th class="num">Tracked</th>
          ${estimationHeaderCell}
        </tr>
      </thead>
      <tbody>${rows}${totalRow}</tbody>
    </table>
  </div>
  ${individualSummarySection}
</body>
</html>`;
  }

  private formatDuration(duration: number) {
    return formatDuration(duration);
  }

  private escapeHtml(value: string) {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll('\'', '&#39;');
  }
}
