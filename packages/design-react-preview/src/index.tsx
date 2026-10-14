import {
  createContext,
  useContext,
  createElement,
  type ComponentType,
  type ReactNode,
} from 'react';
import { reactComponentKey, type JsonValue } from '@editor-platform/react-ui-core';
import {
  designReactResolution,
  type DesignReactConversion,
} from '@editor-platform/design-react-core';
import { ReactComposition, type ReactPreviewRuntime } from '@editor-platform/react-ui-preview';
const NativeSlots = createContext<Record<string, ReactNode>>({});
/** Host-only declarative renderer. No TSX evaluation; exact native source was validated by Host. */
export function nativeDesignRuntime(
  conversion: DesignReactConversion,
  original: ReactPreviewRuntime,
  width: number,
): ReactPreviewRuntime {
  const runtime: ReactPreviewRuntime = {
    ...original,
    resolution: designReactResolution(conversion, original.resolution),
    components: { ...original.components },
  };
  for (const primitive of conversion.primitives)
    runtime.components[reactComponentKey(primitive.registration.ref)] = (
      props: Record<string, unknown>,
    ) => {
      const slots = useContext(NativeSlots);
      return createElement(
        primitive.tag,
        {
          className: props.className,
          style:
            primitive.tag === 'img'
              ? {
                  objectFit: primitive.imageFit === 'fit' ? 'contain' : 'cover',
                  borderRadius: primitive.radius ?? 0,
                }
              : ['span', 'p', 'h1', 'h2', 'label', 'a'].includes(primitive.tag)
                ? { color: props.fill, margin: 0 }
                : { backgroundColor: props.fill, boxSizing: 'border-box' },
          ...(primitive.tag === 'form'
            ? {
                onSubmit: (event: { preventDefault(): void }) => {
                  event.preventDefault();
                  if (typeof props.onSubmit === 'function') (props.onSubmit as () => void)();
                },
              }
            : {}),
          ...(primitive.tag === 'a' ? { href: primitive.href } : {}),
          ...(primitive.tag === 'img' ? { src: props.src, alt: props.alt } : {}),
        },
        ...(primitive.tag === 'img'
          ? []
          : [
              props.text as ReactNode,
              Object.hasOwn(slots, primitive.sourceId)
                ? slots[primitive.sourceId]
                : (props.children as ReactNode),
            ]),
      );
    };
  for (const component of conversion.components)
    runtime.components[reactComponentKey(component.registration.ref)] = ((
      props: Record<string, unknown>,
    ) => {
      const document =
        component.documents[
          component.hasVariants
            ? String(props.variant ?? Object.keys(component.documents)[0])
            : Object.keys(component.documents)[0]
        ];
      if (!document) throw new Error('Unknown explicit native variant');
      const inputs = Object.fromEntries(
        Object.entries(document.inputs).map(([key, field]) => [
          key,
          (props[key] === undefined ? field.default : props[key]) as JsonValue,
        ]),
      );
      const slots = Object.fromEntries(
        Object.values(component.slotTargets)
          .filter((slot) => props[slot.prop] !== undefined)
          .map((slot) => [slot.elementId, props[slot.prop] as ReactNode]),
      );
      return (
        <NativeSlots.Provider value={slots}>
          <div className={props.className as string}>
            <ReactComposition
              document={document}
              runtime={runtime}
              width={width}
              inputs={inputs}
              callback={(nodeId, event, args) => {
                const binding = document.nodes.find((n) => n.id === nodeId)?.bindings[event];
                if (binding?.kind === 'callback' && typeof props[binding.callback] === 'function')
                  (props[binding.callback] as (...a: JsonValue[]) => void)(...args);
              }}
            />
          </div>
        </NativeSlots.Provider>
      );
    }) as ComponentType<Record<string, unknown>>;
  return runtime;
}
