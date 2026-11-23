
struct BankTwilightLight {
  amount: f32,
  direct: f32,
  ambient: f32,
  tint: vec3<f32>,
};

fn bankTwilight(sunHeight: f32, enabled: bool) -> BankTwilightLight {
  if (!enabled) { return BankTwilightLight(0.0, 1.0, 1.0, vec3<f32>(1.0)); }
  let afterglow = smoothstep(-0.24, -0.07, sunHeight);
  let low = 1.0 - smoothstep(0.035, 0.35, sunHeight);
  let amount = afterglow * low;
  let direct = smoothstep(-0.076, 0.034, sunHeight);
  let ambient = mix(0.12, 1.0, smoothstep(-0.26, 0.035, sunHeight));
  let nearHorizon = 1.0 - smoothstep(0.015, 0.21, sunHeight);
  let amber = mix(vec3<f32>(1.20, 0.85, 0.63), vec3<f32>(1.47, 0.68, 0.38), nearHorizon);
  return BankTwilightLight(amount, direct, ambient, mix(vec3<f32>(1.0), amber, low));
}
