<?php

namespace Custom\Bar\Plugin;

class FooPlugin
{
    public function beforeSave($subject): void {}
    public function afterGetName($subject, $result): string {}
    public function aroundLoad($subject, callable $proceed): void {}
}
