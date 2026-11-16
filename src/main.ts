import './styles.css';
import { RowerController } from './core/controller';
import { Dashboard } from './ui/dashboard';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app fehlt');

const dashboard = new Dashboard(root, {
  onToggle: () => controller.toggle(),
  onReset: () => controller.reset(),
  onDragFactor: (value) => controller.setDragFactor(value),
  onSourceChange: (kind, url) => void controller.switchSource(kind, url ? { url } : {}),
  onEffortChange: (spm, pace) => controller.setDemoEffort(spm, pace),
  onConnectStrap: () => {
    void controller
      .connectStrap()
      .then((name) => dashboard.setHeartRateLabel(`Gurt: ${name}`))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Kein Gurt gefunden';
        dashboard.setHeartRateLabel(message);
      });
  },
  onWorkoutChange: (meters, seconds) => {
    controller.setWorkout(
      meters !== null
        ? { kind: 'distance', distanceM: meters }
        : seconds !== null
          ? { kind: 'time', durationSec: seconds }
          : { kind: 'free' },
    );
    dashboard.setWorkoutLabel(
      meters !== null
        ? `Ziel: ${new Intl.NumberFormat('de-DE').format(meters)} m`
        : seconds !== null
          ? `Ziel: ${Math.round(seconds / 60)} min`
          : 'Freies Rudern',
    );
    dashboard.setSessionState('idle');
    controller.reset();
  },
});

const controller = new RowerController({
  onFrame: (frame) => dashboard.render(frame),
  onStatus: (status) => dashboard.updateStatus(status),
  onSession: (state) => dashboard.setSessionState(state),
});

void controller.init();
